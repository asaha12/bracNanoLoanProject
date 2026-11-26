const { validateAllCredentials } = require('../services/credentialService');
const { fetchConfiguredOffice } = require('../services/officeService');
const {
  fetchConfiguredLoanProducts,
  fetchActiveNanoLoanProductByProject
} = require('../services/loanProductService');
const { loadLiveAssessmentConfig } = require('../services/assessmentConfigService');
const {
  matchNumericBand,
  matchSeqBand,
  getScoreParameterConfig
} = require('./bandEvaluator');
const {
  toDhakaDateStr,
  addMonths,
  addYears,
  diffDays,
  lastDayOfMonth,
  isInLastWorkingDaysOfMonth,
  expandDateRange
} = require('../utils/dateUtils');

function matchesLoanAccStatus(loanStatusId, statusFilter) {
  if (!statusFilter || statusFilter === 'ALL') return true;
  if (statusFilter === 'ACTIVE') return Number(loanStatusId) !== 2;
  if (statusFilter === 'CLOSED') return Number(loanStatusId) === 2;
  return true;
}

/**
 * Evaluates scheduled installments on a single loan using cumulative net realized repayments.
 * When `ignoreNegativeReversals` is true, reproduces BRAC ERP's `WHERE realized > 0` behavior
 * strictly to verify whether a DB mismatch is caused by ERP's un-netted reversal QA bug.
 */
function scoreLoanInstallmentBehavior({
  allLcRows,
  instAmt,
  evalPeriodCutoffStr,
  businessDateStr,
  holidaySet,
  bands,
  projectId,
  ignoreNegativeReversals = false
}) {
  const payFilter = (r) =>
    ignoreNegativeReversals ? Number(r.realized_amount) > 0 : Number(r.realized_amount) !== 0;

  const lifeTotal = allLcRows
    .filter(payFilter)
    .reduce((sum, r) => sum + Number(r.realized_amount || 0), 0);

  // Build scheduled due installments across loan life (1..k)
  const schedRows = [];
  let schedIdx = 0;
  for (const r of allLcRows) {
    if (r.is_collection_date === true) {
      schedIdx += 1;
      schedRows.push({
        ...r,
        installmentNo: schedIdx,
        monthEndStr: lastDayOfMonth(r.bd_date),
        cumExpected: Math.min(instAmt * schedIdx, lifeTotal)
      });
    }
  }

  // Filter to completed due months within [evalPeriodCutoffStr .. businessDateStr]
  const dueRows = schedRows.filter(
    (s) => s.monthEndStr <= businessDateStr && s.bd_date >= evalPeriodCutoffStr
  );

  if (dueRows.length === 0) {
    return null;
  }

  // Build cumulative paid timeline
  const payEvents = [];
  if (ignoreNegativeReversals) {
    let cum = 0;
    for (const r of allLcRows) {
      if (Number(r.realized_amount) > 0) {
        cum += Number(r.realized_amount);
        payEvents.push({ bdDate: r.bd_date, cumPaid: cum, effectivePaid: cum });
      }
    }
  } else {
    // Collapse same-day entries (e.g. double post + same-day reversal) first, then compute suffix-min
    // so a payment later reversed never permanently satisfies a future installment.
    const dailyMap = new Map();
    for (const r of allLcRows) {
      const amt = Number(r.realized_amount || 0);
      if (amt !== 0) {
        dailyMap.set(r.bd_date, (dailyMap.get(r.bd_date) || 0) + amt);
      }
    }
    let cum = 0;
    for (const [bdDate, netAmt] of dailyMap.entries()) {
      cum += netAmt;
      payEvents.push({ bdDate, cumPaid: cum, effectivePaid: cum });
    }
    let suffixMin = Infinity;
    for (let i = payEvents.length - 1; i >= 0; i -= 1) {
      suffixMin = Math.min(suffixMin, payEvents[i].cumPaid);
      payEvents[i].effectivePaid = suffixMin;
    }
  }

  let worstScore = 5;
  let onTimeOrWithinMonthCount = 0;
  const installmentBreakdowns = [];

  for (const due of dueRows) {
    // Find earliest payment date where cumulative paid permanently satisfies cumExpected
    let rawSatisfiedOn = null;
    for (const pe of payEvents) {
      if (pe.effectivePaid + 0.0001 >= due.cumExpected) {
        if (rawSatisfiedOn === null || pe.bdDate < rawSatisfiedOn) {
          rawSatisfiedOn = pe.bdDate;
        }
      }
    }

    let satisfiedOn = rawSatisfiedOn;
    if (
      Number(due.overdue_amount) === 0 &&
      (satisfiedOn === null || satisfiedOn > due.bd_date)
    ) {
      satisfiedOn = due.bd_date;
    }

    let instSeq = 1;
    let instScore = 5;
    if (!satisfiedOn) {
      instSeq = 4;
      instScore = 2;
    } else if (satisfiedOn <= due.bd_date) {
      instSeq = 1;
      instScore = 5;
    } else if (satisfiedOn > due.monthEndStr) {
      instSeq = 4;
      instScore = 2;
    } else if (isInLastWorkingDaysOfMonth(satisfiedOn, 3, holidaySet)) {
      instSeq = 3;
      instScore = 3;
    } else {
      instSeq = 2;
      instScore = 4;
    }

    if (instScore >= 4) {
      onTimeOrWithinMonthCount += 1;
    }
    worstScore = Math.min(worstScore, instScore);

    installmentBreakdowns.push({
      installmentNo: due.installmentNo,
      dueDate: due.bd_date,
      satisfiedOn,
      cumExpected: due.cumExpected,
      score: instScore,
      seq: instSeq
    });
  }

  const worstSeq = worstScore === 5 ? 1 : worstScore === 4 ? 2 : worstScore === 3 ? 3 : 4;
  const fallbackP1 =
    worstSeq === 1
      ? { score: 5, label: 'On scheduled date' }
      : worstSeq === 2
      ? { score: 4, label: 'Within the month' }
      : worstSeq === 3
      ? { score: 3, label: 'Within last 3 working days' }
      : { score: 2, label: 'Exceeding the month' };

  const matched = matchSeqBand(
    bands,
    'INSTALLMENT_PAYMENT_BEHAVIOR',
    projectId,
    worstSeq,
    fallbackP1
  );

  return {
    dueCount: dueRows.length,
    numerator: onTimeOrWithinMonthCount,
    denominator: dueRows.length,
    dueMonthPass: worstScore >= 3,
    score: matched.score,
    behaviorLabel: matched.label,
    installmentBreakdowns
  };
}

class NanoLoanEvaluator {
  constructor(client, appConfig, options = {}) {
    this.client = client;
    this.appConfig = appConfig;
    this.skipCredentialValidation = Boolean(options.skipCredentialValidation);
    this.config = null;
    this.latestRun = null;
    this.configDrift = [];
    this.credentialValidation = null;
    this.configuredOffice = null;
    this.configuredLoanProducts = [];
  }

  /**
   * Always fetches and validates fresh live configuration on every run:
   *  1. Branch & Head Office ERP Credential Authentication (Keycloak OIDC + application_user)
   *  2. Configured Microfinance Branch Office validation (physical_office_info: office.id & branch.office.code)
   *  3. Configured Dabi & Progoti Loan Products live schema & project mapping
   *  4. Live Credit Risk Model Assessment Configuration tables + latest batch run drift check
   */
  async loadLiveConfiguration() {
    if (!this.skipCredentialValidation) {
      this.credentialValidation = await validateAllCredentials(this.client, this.appConfig);
    }

    this.configuredOffice = await fetchConfiguredOffice(this.client, this.appConfig);
    this.configuredLoanProducts = await fetchConfiguredLoanProducts(this.client, this.appConfig);

    const { liveConfig, latestRun, configDrift } = await loadLiveAssessmentConfig(
      this.client,
      this.appConfig,
      this.configuredLoanProducts
    );

    this.config = liveConfig;
    this.latestRun = latestRun;
    this.configDrift = configDrift;

    return {
      credentialValidation: this.credentialValidation,
      configuredOffice: this.configuredOffice,
      configuredLoanProducts: this.configuredLoanProducts,
      liveConfig: this.config,
      latestRun: this.latestRun,
      configDrift: this.configDrift
    };
  }

  async resolveApplicableLoanProduct(projectId, projectName) {
    const expectedConfigured = this.configuredLoanProducts.find(
      (p) => p.expectedProjectId === projectId
    );

    if (expectedConfigured) {
      if (
        expectedConfigured.found &&
        expectedConfigured.isActive &&
        expectedConfigured.projectMappingVerified
      ) {
        return {
          product: expectedConfigured,
          matchedFromProperties: true,
          verified: true,
          verificationMessage: `✅ Verified: Member project [${projectName || `ID ${projectId}`}] matched configured ${expectedConfigured.propertyName}=${expectedConfigured.id} (${expectedConfigured.loanName}).`,
          note: null
        };
      }

      const issues = [];
      if (!expectedConfigured.found) {
        issues.push(`product ID ${expectedConfigured.id} not found in DB`);
      } else {
        if (!expectedConfigured.isActive) {
          issues.push(`product ID ${expectedConfigured.id} is inactive (status ${expectedConfigured.domainStatusId})`);
        }
        if (!expectedConfigured.projectMappingVerified) {
          const actual =
            expectedConfigured.mappedProjects
              .map((mp) => `${mp.projectName} (ID: ${mp.projectInfoId})`)
              .join(', ') || 'NONE';
          issues.push(`product ID ${expectedConfigured.id} is mapped to [${actual}] instead of Project ID ${projectId}`);
        }
      }

      const mappedConfigured = this.configuredLoanProducts.find(
        (p) => p.found && p.mappedProjects.some((mp) => mp.projectInfoId === projectId)
      );

      if (mappedConfigured) {
        return {
          product: mappedConfigured,
          matchedFromProperties: true,
          verified: false,
          verificationMessage: `⚠️ Verification Mismatch: ${expectedConfigured.propertyName}=${expectedConfigured.id} failed check (${issues.join('; ')}). Using ${mappedConfigured.propertyName}=${mappedConfigured.id} (${mappedConfigured.loanName}) which actually maps to Project ID ${projectId}.`,
          note: `Check config/config.properties: ${expectedConfigured.propertyName} and ${mappedConfigured.propertyName} appear to be swapped or misconfigured.`
        };
      }

      return {
        product: expectedConfigured.found ? expectedConfigured : null,
        matchedFromProperties: true,
        verified: false,
        verificationMessage: `❌ Verification Failed: ${expectedConfigured.propertyName}=${expectedConfigured.id} failed check (${issues.join('; ')}).`,
        note: `Update ${expectedConfigured.propertyName} in config/config.properties with an active Nano Loan product mapped to Project ID ${projectId}.`
      };
    }

    const matchingConfigured = this.configuredLoanProducts.find(
      (p) => p.found && p.mappedProjects.some((mp) => mp.projectInfoId === projectId)
    );

    if (matchingConfigured) {
      return {
        product: matchingConfigured,
        matchedFromProperties: true,
        verified: matchingConfigured.isActive,
        verificationMessage: `✅ Verified: Member project [${projectName || `ID ${projectId}`}] matched configured ${matchingConfigured.propertyName}=${matchingConfigured.id} (${matchingConfigured.loanName}).`,
        note: null
      };
    }

    const projectNanoProduct = await fetchActiveNanoLoanProductByProject(
      this.client,
      projectId,
      this.appConfig
    );

    if (projectNanoProduct && projectNanoProduct.found) {
      return {
        product: projectNanoProduct,
        matchedFromProperties: false,
        verified: false,
        verificationMessage: `ℹ️ Member belongs to project [${projectName || `ID ${projectId}`}] (neither Dabi=1 nor Progoti=2). Applied live active Nano Loan product #${projectNanoProduct.id} (${projectNanoProduct.loanName}).`,
        note: null
      };
    }

    return {
      product: null,
      matchedFromProperties: false,
      verified: false,
      verificationMessage: `⚠️ No configured or active Nano Loan product found for member project [${projectName || `ID ${projectId}`}]. Falling back to assessment ceilings.`,
      note: null
    };
  }

  async evaluateMember(memberIdOrNo) {
    if (!this.config) {
      await this.loadLiveConfiguration();
    }

    const client = this.client;
    const configuredOfficeId = this.appConfig.office.id;

    // 1. Fetch Member Info (join physical_office_info for accurate Microfinance branch code/name;
    //    support member_info.id, member_no, OR report Member No `reference_no` in configured office)
    const memRes = await client.query(
      `
      SELECT m.*,
             COALESCE(NULLIF(BTRIM(po.mf_branch_id), ''), po.office_code) AS office_code,
             po.office_name,
             p.project_name
      FROM member_info m
      LEFT JOIN physical_office_info po ON po.id = m.branch_info_id
      LEFT JOIN project_info p ON p.id = m.project_info_id
      WHERE m.id::text = $1
         OR m.member_no = $1
         OR (m.reference_no = $1 AND m.branch_info_id = $2)
      ORDER BY CASE
        WHEN m.id::text = $1 THEN 1
        WHEN m.member_no = $1 THEN 2
        ELSE 3
      END ASC
      LIMIT 1
      `,
      [String(memberIdOrNo), configuredOfficeId]
    );

    if (memRes.rows.length === 0) {
      return {
        error: `Member with ID / Member No "${memberIdOrNo}" not found in database (or in configured office.id=${configuredOfficeId}).`,
        environment: this.buildEnvironmentSummary()
      };
    }

    const member = memRes.rows[0];
    const memberId = Number(member.id);
    const officeId = Number(member.branch_info_id);
    const projectId = Number(member.project_info_id);

    const officeMismatchWarning =
      officeId !== configuredOfficeId
        ? `Member belongs to Branch [${member.office_code}] ${member.office_name} (ID: ${officeId}), whereas config.properties has office.id=${configuredOfficeId}. Queries were partition-pruned using member's owning office_info_id=${officeId}.`
        : null;

    const applicableProductInfo = await this.resolveApplicableLoanProduct(
      projectId,
      member.project_name
    );
    const applicableProduct = applicableProductInfo.product;

    const businessDateStr = toDhakaDateStr(this.config.business_date) || '2026-10-31';
    const historyYears = this.config.history_years || 4;
    const historyCutoffStr = addYears(businessDateStr, -historyYears);
    const toggles = this.config.toggles || {};

    // Collect probe offices (only query member_transfer_history when member.is_transferred_member is true)
    const probeOfficeSet = new Set([officeId]);
    if (member.is_transferred_member) {
      const transferRes = await client.query(
        `
        SELECT from_office_id, to_office_id
        FROM member_transfer_history
        WHERE member_id = $1
          AND (transfer_date AT TIME ZONE 'Asia/Dhaka')::date <= $2::date
        `,
        [memberId, businessDateStr]
      );
      for (const tr of transferRes.rows) {
        if (tr.from_office_id) probeOfficeSet.add(Number(tr.from_office_id));
        if (tr.to_office_id) probeOfficeSet.add(Number(tr.to_office_id));
      }
    }
    const probeOffices = Array.from(probeOfficeSet);

    // 2. Fetch General Loans (Partitioned by office_info_id across probeOffices)
    const productIds = this.config.general_loan_product_ids;
    const loanStatusIds = this.config.loan_status_ids || [1, 2, 3, 4];
    const frequencyId = this.config.frequency_id || 3;

    const loansRes = await client.query(
      `
      SELECT la.id, la.account_no, la.loan_status_id, la.disbursed_amount,
             la.outstanding_balance, la.total_amount, la.product_info_id,
             la.project_info_id, la.office_info_id, la.disbursement_date, la.date_created,
             la.first_installment_date, la.settlement_date, la.installment_amount, la.no_of_installment,
             TO_CHAR(la.disbursement_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS disb_date_bd,
             TO_CHAR(la.first_installment_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS first_inst_date_bd,
             TO_CHAR(la.settlement_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS settle_date_bd,
             lp.loan_name AS product_name
      FROM loan_account la
      JOIN loan_product lp ON lp.id = la.product_info_id
      WHERE la.member_id = $1
        AND la.office_info_id = ANY($2::bigint[])
        AND la.domain_status_id = 1
        AND la.frequency_id = $3
        AND la.loan_status_id = ANY($4::bigint[])
        AND la.product_info_id = ANY($5::bigint[])
        AND (la.disbursement_date AT TIME ZONE 'Asia/Dhaka')::date <= $6::date
      ORDER BY la.disbursement_date DESC, la.id DESC
      `,
      [memberId, probeOffices, frequencyId, loanStatusIds, productIds, businessDateStr]
    );

    const allGeneralLoans = loansRes.rows.map((l, idx) => ({
      ...l,
      loanRank: idx + 1
    }));

    const loansToSelectCount = this.config.loans_to_select || this.config.number_of_loans_to_avg || 2;
    const selectedLoans = allGeneralLoans.slice(0, loansToSelectCount);
    const eligibleWindowLoans = allGeneralLoans.filter((l) => {
      const d = l.disb_date_bd || toDhakaDateStr(l.disbursement_date);
      return d && d >= historyCutoffStr && d <= businessDateStr;
    });

    // ----------------------------------------------------
    // STEP 1: Minimum Loan Cycle
    // ----------------------------------------------------
    const minLoanCycle = this.config.minimum_loan_cycle || 2;
    const oldestSelectedDisb =
      selectedLoans.length > 0
        ? selectedLoans[selectedLoans.length - 1].disb_date_bd ||
          toDhakaDateStr(selectedLoans[selectedLoans.length - 1].disbursement_date)
        : null;

    let step1Pass = true;
    let step1Reason = null;
    if (toggles.MIN_LOAN_CYCLE !== false) {
      if (allGeneralLoans.length < minLoanCycle) {
        step1Pass = false;
        step1Reason = `Only ${allGeneralLoans.length} general loan(s), minimum ${minLoanCycle} required`;
      } else if (oldestSelectedDisb && oldestSelectedDisb < historyCutoffStr) {
        step1Pass = false;
        step1Reason = `Loan history exceeds the ${historyYears}-year window`;
      }
    }

    const step1Result = {
      step: 1,
      name: 'Minimum Loan Cycle',
      requiredCount: minLoanCycle,
      historyYears,
      actualCount: eligibleWindowLoans.length,
      totalQualifyingCount: allGeneralLoans.length,
      historyCutoff: historyCutoffStr,
      passed: step1Pass,
      reason: step1Reason
    };

    // ----------------------------------------------------
    // STEP 2: Running Loan Repayment Requirement
    // ----------------------------------------------------
    const runningLoans = selectedLoans.filter((l) => Number(l.loan_status_id) !== 2);
    let step2Pass = true;
    let step2Reason = null;
    let runningLoan = null;
    let runningLoanRepaidPct = null;

    const reqPct = Number(this.config.required_paid_percentage || 30.0);

    if (runningLoans.length > 0) {
      runningLoan = runningLoans[0];
      const disbursed = Number(runningLoan.disbursed_amount);
      const outstanding = Number(runningLoan.outstanding_balance);
      runningLoanRepaidPct = disbursed > 0 ? ((disbursed - outstanding) / disbursed) * 100 : 0;

      if (toggles.RUNNING_REPAYMENT !== false) {
        step2Pass = runningLoanRepaidPct >= reqPct;
        if (!step2Pass) {
          step2Reason = `Latest running loan repaid ${runningLoanRepaidPct.toFixed(1)}%, requires ${reqPct}%`;
        }
      }
    } else {
      step2Pass = true;
      step2Reason = 'Skipped (No active running loan)';
    }

    const step2Result = {
      step: 2,
      name: 'Running Loan Repayment Requirement',
      hasRunningLoan: runningLoans.length > 0,
      runningLoanId: runningLoan ? runningLoan.id : null,
      disbursedAmount: runningLoan ? Number(runningLoan.disbursed_amount) : null,
      outstandingBalance: runningLoan ? Number(runningLoan.outstanding_balance) : null,
      repaidPct: runningLoanRepaidPct !== null ? Number(runningLoanRepaidPct.toFixed(4)) : null,
      requiredPct: reqPct,
      passed: step2Pass,
      reason: step2Pass
        ? runningLoans.length === 0
          ? 'No running loan (Criterion skipped)'
          : null
        : step2Reason
    };

    // ----------------------------------------------------
    // STEP 3 (Due Month Repayment) & STEP 5 Param 1
    // ----------------------------------------------------
    const evalPeriodValue = Number(this.config.due_month_evaluation_period || 12);
    const evalPeriodUnit = String(this.config.due_month_evaluation_period_unit || 'MONTH').toUpperCase();
    const evalPeriodCutoffStr =
      evalPeriodUnit === 'YEAR'
        ? addYears(businessDateStr, -evalPeriodValue)
        : addMonths(businessDateStr, -evalPeriodValue);

    const numToAvg = this.config.number_of_loans_to_avg || 2;
    const bands = this.config.score_bands;
    const params = this.config.score_parameters;
    const p1Conf = getScoreParameterConfig(params, 'INSTALLMENT_PAYMENT_BEHAVIOR', projectId);
    const p1StatusFilter = (p1Conf && p1Conf.loanAccStatus) || 'ALL';
    const p1Loans = selectedLoans.filter((l) =>
      matchesLoanAccStatus(l.loan_status_id, p1StatusFilter)
    );

    let step3Pass = true;
    let step3Reason = null;
    let totalDueMonthsChecked = 0;
    const param1Details = [];
    const qaFindings = [];

    // Load active holidays per loan office for accurate Bangladesh last-3-working-days check
    const holidayRes = await client.query(
      `
      SELECT office_id,
             TO_CHAR(from_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS from_bd,
             TO_CHAR(to_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS to_bd
      FROM holiday
      WHERE status_id = 1
        AND (office_id IS NULL OR office_id = ANY($1::bigint[]))
        AND (to_date AT TIME ZONE 'Asia/Dhaka')::date >= $2::date
        AND (from_date AT TIME ZONE 'Asia/Dhaka')::date <= $3::date
      `,
      [probeOffices, evalPeriodCutoffStr, businessDateStr]
    );

    const getHolidaySetForOffice = (targetOffId, includeNullGlobal = true) => {
      const set = new Set();
      for (const h of holidayRes.rows) {
        if (
          (includeNullGlobal && h.office_id === null) ||
          Number(h.office_id) === Number(targetOffId)
        ) {
          for (const dt of expandDateRange(h.from_bd, h.to_bd)) {
            set.add(dt);
          }
        }
      }
      return set;
    };

    for (const loan of p1Loans) {
      const loanOfficeId = Number(loan.office_info_id);
      const lcRes = await client.query(
        `
        SELECT lc.id, lc.collection_no,
               TO_CHAR(lc.collection_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS bd_date,
               TO_CHAR(lc.collection_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM') AS bd_ym,
               lc.is_collection_date, lc.realizable_amount, lc.realized_amount,
               COALESCE(lc.overdue_amount, 0) AS overdue_amount
        FROM loan_collection lc
        WHERE lc.office_info_id = $1
          AND lc.loan_account_id = $2
          AND lc.domain_status_id = 1
          AND (lc.collection_date AT TIME ZONE 'Asia/Dhaka')::date <= $3::date
        ORDER BY lc.collection_date ASC, lc.id ASC
        `,
        [loanOfficeId, loan.id, businessDateStr]
      );

      const allLcRows = lcRes.rows;
      const instAmt = Number(loan.installment_amount || 0);
      const holidaySet = getHolidaySetForOffice(loanOfficeId, true);

      const srsP1 = scoreLoanInstallmentBehavior({
        allLcRows,
        instAmt,
        evalPeriodCutoffStr,
        businessDateStr,
        holidaySet,
        bands,
        projectId,
        ignoreNegativeReversals: false
      });

      if (!srsP1) {
        continue;
      }

      // Check if loan has reversed collection entries (`realized_amount < 0`) that trigger ERP's `WHERE realized > 0` bug
      const reversalRows = allLcRows.filter((r) => Number(r.realized_amount) < 0);
      let erpBugDiag = null;
      if (reversalRows.length > 0) {
        const erpUnnettedP1 = scoreLoanInstallmentBehavior({
          allLcRows,
          instAmt,
          evalPeriodCutoffStr,
          businessDateStr,
          holidaySet: getHolidaySetForOffice(loanOfficeId, false),
          bands,
          projectId,
          ignoreNegativeReversals: true
        });

        if (erpUnnettedP1 && erpUnnettedP1.score !== srsP1.score) {
          const revSummary = reversalRows
            .map((r) => `${r.bd_date}: BDT ${Number(r.realized_amount).toLocaleString('en-US')}`)
            .join(', ');
          erpBugDiag = {
            type: 'ERP_REVERSAL_IGNORED_BUG',
            loanId: loan.id,
            srsScore: srsP1.score,
            erpScore: erpUnnettedP1.score,
            message: `Confirmed ERP Backend QA Bug on Loan ${loan.id}: loan_collection contains reversed collection row(s) (${revSummary}). ERP SQL function fn_credit_risk_model_stage_b_param1 filters "WHERE realized > 0" and ignores negative reversals, inflating cumulative paid amount so late repayments are misclassified as "${erpUnnettedP1.behaviorLabel}" (Score ${erpUnnettedP1.score}) instead of SRS "${srsP1.behaviorLabel}" (Score ${srsP1.score}).`
          };
          qaFindings.push(erpBugDiag);
        }
      }

      totalDueMonthsChecked += srsP1.dueCount;
      if (!srsP1.dueMonthPass && toggles.DUE_MONTH_REPAYMENT !== false) {
        step3Pass = false;
        step3Reason = 'Installment(s) not repaid within their due month';
      }

      param1Details.push({
        loanId: loan.id,
        disbursedAmount: Number(loan.disbursed_amount),
        collectionsCount: srsP1.dueCount,
        numerator: srsP1.numerator,
        denominator: srsP1.denominator,
        behaviorLabel: srsP1.behaviorLabel,
        score: srsP1.score,
        dueMonthPass: srsP1.dueMonthPass,
        qaBugDiag: erpBugDiag
      });
    }

    const step3Result = {
      step: 3,
      name: 'Due Month Repayment Criteria',
      evaluationPeriod: evalPeriodValue,
      evaluationPeriodUnit: evalPeriodUnit,
      evaluationRule: this.config.due_month_evaluation_rule || 'WITHIN_THE_MONTH',
      evaluationPeriodCutoff: evalPeriodCutoffStr,
      totalCollectionsChecked: totalDueMonthsChecked,
      passed: step3Pass,
      reason: step3Pass ? null : step3Reason
    };

    // ----------------------------------------------------
    // STEP 4: Eligible Loan Amount Calculation (Live Loan Product Ceilings)
    // ----------------------------------------------------
    const amtStatusFilter = this.config.loan_amount_calc_loan_acc_status || 'ALL';
    const loansMatchingAmtStatus = allGeneralLoans.filter((l) =>
      matchesLoanAccStatus(l.loan_status_id, amtStatusFilter)
    );
    const loansToAvg = loansMatchingAmtStatus.slice(0, numToAvg);

    let avgDisbursedAmount = 0;
    let computedCeiling = 0;
    let step4Pass = true;
    let step4Reason = null;

    const eligPctValue = Number(this.config.eligible_loan_percentage || 20);

    if (loansToAvg.length >= numToAvg) {
      const sumDisbursed = loansToAvg.reduce((sum, l) => sum + Number(l.disbursed_amount), 0);
      avgDisbursedAmount = sumDisbursed / numToAvg;
      computedCeiling = Number(((avgDisbursedAmount * eligPctValue) / 100).toFixed(4));
    } else if (toggles.LOAN_AMOUNT_CALC !== false) {
      step4Pass = false;
      step4Reason = `Only ${loansToAvg.length} ${amtStatusFilter}-status loan(s), ${numToAvg} required to compute an amount`;
    }

    let projectCap = null;
    if (
      applicableProduct &&
      applicableProduct.found &&
      applicableProduct.minLoanAmount !== null &&
      applicableProduct.maxLoanAmount !== null
    ) {
      projectCap = {
        min_amount: applicableProduct.minLoanAmount,
        max_amount: applicableProduct.maxLoanAmount,
        source: `Live Loan Product #${applicableProduct.id} (${applicableProduct.loanName})`
      };
    } else {
      const confCap = (this.config.project_ceilings || []).find(
        (p) => Number(p.project_info_id) === projectId
      );
      projectCap = confCap || {
        min_amount: 20000,
        max_amount: projectId === 2 ? 100000 : 50000,
        source: 'SRS Default Fallback'
      };
    }

    const minEligibleAmount = projectCap.min_amount;
    let maxEligibleAmount = computedCeiling;

    if (step4Pass && toggles.LOAN_AMOUNT_CALC !== false) {
      if (computedCeiling < projectCap.min_amount) {
        step4Pass = false;
        step4Reason = `Computed ceiling ${Math.round(computedCeiling)} below project minimum ${projectCap.min_amount}`;
      } else if (computedCeiling > projectCap.max_amount) {
        maxEligibleAmount = projectCap.max_amount;
      }
    }

    const step4Result = {
      step: 4,
      name: 'Eligible Loan Amount Calculation',
      loansAveragedCount: loansToAvg.length,
      loansAveraged: loansToAvg.map((l) => ({
        id: l.id,
        accountNo: l.account_no,
        disbursed: Number(l.disbursed_amount),
        date: l.disbursement_date
      })),
      avgDisbursedAmount: Number(avgDisbursedAmount.toFixed(2)),
      eligiblePercentage: eligPctValue,
      computedCeiling,
      projectMinCeiling: projectCap.min_amount,
      projectMaxCeiling: projectCap.max_amount,
      ceilingSource: projectCap.source,
      minEligibleAmount: step4Pass ? minEligibleAmount : projectCap.min_amount,
      maxEligibleAmount: step4Pass ? maxEligibleAmount : computedCeiling,
      passed: step4Pass,
      reason: step4Reason
    };

    // ----------------------------------------------------
    // STEP 5: Credit Scoring Parameters (Live Bands & Parameters)
    // ----------------------------------------------------
    const hasParam1Data = param1Details.length > 0;
    const param1Score = hasParam1Data
      ? Number(
          (param1Details.reduce((s, p) => s + p.score, 0) / param1Details.length).toFixed(4)
        )
      : null;

    // Param 2: Savings Paid with Loan Installment
    const p2Conf = getScoreParameterConfig(params, 'SAVINGS_PAID_WITH_INSTALLMENT', projectId);
    const p2StatusFilter = (p2Conf && p2Conf.loanAccStatus) || 'ALL';
    const p2SavType = p2Conf && p2Conf.savingsAccountType !== undefined ? p2Conf.savingsAccountType : 1;
    const p2Loans = selectedLoans.filter((l) =>
      matchesLoanAccStatus(l.loan_status_id, p2StatusFilter)
    );
    const param2Details = [];

    for (const loan of p2Loans) {
      const loanOfficeId = Number(loan.office_info_id);
      const loanStartDate =
        loan.first_inst_date_bd ||
        toDhakaDateStr(loan.first_installment_date) ||
        loan.disb_date_bd ||
        toDhakaDateStr(loan.disbursement_date);
      const rawSettleDate = loan.settle_date_bd || toDhakaDateStr(loan.settlement_date);
      const loanEndDate =
        rawSettleDate && rawSettleDate <= businessDateStr ? rawSettleDate : businessDateStr;
      const instAmt = Number(loan.installment_amount || 0);

      const res = await client.query(
        `
        WITH sched_stats AS (
          SELECT COUNT(*) AS sched_count
          FROM loan_collection lc
          WHERE lc.office_info_id = $3
            AND lc.loan_account_id = $4
            AND lc.is_collection_date = true
            AND lc.domain_status_id = 1
            AND (lc.collection_date AT TIME ZONE 'Asia/Dhaka')::date <= $5::date
        ),
        compulsory_savings AS (
          SELECT COALESCE(SUM(s.deposit_amount), 0) AS total_savings
          FROM savings_account_transaction s
          LEFT JOIN savings_account sa
            ON sa.id = s.savings_account_id
           AND sa.office_info_id = s.office_info_id
          WHERE s.office_info_id = $2
            AND s.member_info_id = $1
            AND ($6::bigint IS NULL OR sa.account_type_id = $6::bigint)
            AND s.domain_status_id = 1
            AND s.deposit_amount > 0
            AND s.trx_type != 4
            AND s.transaction_date >= $7::timestamptz
            AND (s.transaction_date AT TIME ZONE 'Asia/Dhaka')::date <= $5::date
        )
        SELECT cs.total_savings, ss.sched_count
        FROM compulsory_savings cs, sched_stats ss
        `,
        [
          memberId,
          officeId,
          loanOfficeId,
          loan.id,
          loanEndDate,
          p2SavType,
          loan.first_installment_date || loan.disbursement_date
        ]
      );

      const totalSavings = Number(res.rows[0]?.total_savings || 0);
      const schedCount = Number(res.rows[0]?.sched_count || 0);
      const totalInstallment = instAmt * schedCount;
      const pct =
        totalInstallment > 0
          ? Number(((totalSavings / totalInstallment) * 100).toFixed(4))
          : null;

      const fallbackP2 =
        projectId === 1
          ? pct !== null && pct >= 10
            ? { score: 5, label: '10% of loan value deposited to savings per installment' }
            : pct !== null && pct >= 5
            ? { score: 4, label: '5% to 9% deposited to savings per installment' }
            : pct !== null && pct >= 1
            ? { score: 3, label: '1% to 4% deposited to savings per installment' }
            : { score: 2, label: '0% deposited to savings per installment' }
          : pct !== null && pct > 3
          ? { score: 5, label: '>3% of loan value deposited to savings per installment' }
          : pct !== null && pct >= 1
          ? { score: 4.5, label: '1% to 3% deposited to savings per installment' }
          : { score: 4, label: '0% deposited to savings per installment' };

      const matched =
        pct !== null
          ? matchNumericBand(
              bands,
              'SAVINGS_PAID_WITH_INSTALLMENT',
              projectId,
              pct,
              fallbackP2
            )
          : { score: 2, label: null };

      param2Details.push({
        loanId: loan.id,
        totalSavings,
        totalInstallment,
        ratioPct: pct !== null ? Number(pct.toFixed(4)) : 0,
        behaviorLabel: matched.label,
        score: matched.score
      });
    }

    const param2Score =
      param2Details.length > 0
        ? Number(
            (param2Details.reduce((s, p) => s + p.score, 0) / param2Details.length).toFixed(4)
          )
        : null;

    // Param 3: Savings Adjustment of Previous Loan
    const p3Conf = getScoreParameterConfig(params, 'SAVINGS_ADJUSTMENT_PREV_LOAN', projectId);
    const p3StatusFilter = (p3Conf && p3Conf.loanAccStatus) || 'ALL';
    const p3SavType = p3Conf && p3Conf.savingsAccountType !== undefined ? p3Conf.savingsAccountType : 1;
    const p3Loans = selectedLoans.filter((l) =>
      matchesLoanAccStatus(l.loan_status_id, p3StatusFilter)
    );
    const param3Details = [];

    for (const loan of p3Loans) {
      const loanOfficeId = Number(loan.office_info_id);
      const latAdjRes = await client.query(
        `
        SELECT transaction_no, collection_amount
        FROM loan_account_transaction
        WHERE office_info_id = $1
          AND loan_account_id = $2
          AND trx_type = 7
          AND domain_status_id = 1
          AND (transaction_date AT TIME ZONE 'Asia/Dhaka')::date <= $3::date
        `,
        [loanOfficeId, loan.id, businessDateStr]
      );

      let adjAmount = 0;
      if (latAdjRes.rows.length > 0) {
        if (!p3SavType) {
          adjAmount = latAdjRes.rows.reduce((s, r) => s + Number(r.collection_amount || 0), 0);
        } else {
          const validTrxNos = latAdjRes.rows
            .map((r) => String(r.transaction_no || '').trim())
            .filter(Boolean);
          if (validTrxNos.length > 0) {
            const satMatchRes = await client.query(
              `
              SELECT sat.transaction_no, sat.withdrawal_amount, sa.account_type_id
              FROM savings_account_transaction sat
              LEFT JOIN savings_account sa
                ON sa.id = sat.savings_account_id
               AND sa.office_info_id = sat.office_info_id
              WHERE sat.office_info_id = $1
                AND sat.member_info_id = $2
                AND sat.trx_type = 3
                AND sat.transaction_no = ANY($3::text[])
              `,
              [loanOfficeId, memberId, validTrxNos]
            );
            for (const latRow of latAdjRes.rows) {
              const tNo = String(latRow.transaction_no || '').trim();
              const amt = Number(latRow.collection_amount || 0);
              const matchedSat = satMatchRes.rows.find(
                (sr) =>
                  String(sr.transaction_no || '').trim() === tNo &&
                  Number(sr.withdrawal_amount) === amt &&
                  Number(sr.account_type_id) === Number(p3SavType)
              );
              if (matchedSat) {
                adjAmount += amt;
              }
            }
          }
        }
      }
      const disbursed = Number(loan.disbursed_amount);
      const adjPct =
        disbursed > 0 ? Number(((adjAmount / disbursed) * 100).toFixed(4)) : 0;

      const fallbackP3 =
        adjPct === 0
          ? { score: 5, label: '0% adjustment made of previous loans' }
          : adjPct <= 25
          ? { score: 4.5, label: '25% adjustment made of previous loans' }
          : adjPct <= 50
          ? { score: 4, label: '50% adjustment made of previous loans' }
          : { score: 2, label: '100% adjustment made of previous loans' };

      const matched = matchNumericBand(
        bands,
        'SAVINGS_ADJUSTMENT_PREV_LOAN',
        projectId,
        adjPct,
        fallbackP3
      );

      param3Details.push({
        loanId: loan.id,
        adjustmentAmount: adjAmount,
        disbursedAmount: disbursed,
        adjustmentPct: adjPct,
        behaviorLabel: matched.label,
        score: matched.score
      });
    }

    const param3Score =
      param3Details.length > 0
        ? Number(
            (param3Details.reduce((s, p) => s + p.score, 0) / param3Details.length).toFixed(4)
          )
        : null;

    // Param 4: Savings Withdrawal Before Repayment
    // SRS §2.1.7: Combines running and closed general loans in chronological rank order
    // (loan 1, loan 2, loan 3, ...) until `installments_to_consider` (11) scheduled collection
    // dates are reached; if fewer than 11 exist across the member's entire general loan history,
    // Param 4 has insufficient history (null -> Step 5 NOT_ELIGIBLE).
    const p4Conf = getScoreParameterConfig(params, 'SAVINGS_WITHDRAWAL_BEFORE_REPAYMENT', projectId);
    const p4StatusFilter = (p4Conf && p4Conf.loanAccStatus) || 'ALL';
    const p4SavType = p4Conf && p4Conf.savingsAccountType !== undefined ? p4Conf.savingsAccountType : 1;
    const daysBeforeRepayment = Number(this.config.days_before_repayment || 7);
    const installmentsToConsider = Number(this.config.installments_to_consider || 11);

    const p4CandidateLoans = allGeneralLoans.filter((l) =>
      matchesLoanAccStatus(l.loan_status_id, p4StatusFilter)
    );

    const consideredRepayDates = [];
    for (const loan of p4CandidateLoans) {
      if (consideredRepayDates.length >= installmentsToConsider) break;
      const needed = installmentsToConsider - consideredRepayDates.length;
      const schedRes = await client.query(
        `
        SELECT TO_CHAR(lc.collection_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS bd_date
        FROM loan_collection lc
        WHERE lc.office_info_id = $1
          AND lc.loan_account_id = $2
          AND lc.is_collection_date = true
          AND lc.domain_status_id = 1
          AND (lc.collection_date AT TIME ZONE 'Asia/Dhaka')::date <= $3::date
        ORDER BY lc.collection_date DESC, lc.id DESC
        LIMIT $4
        `,
        [Number(loan.office_info_id), loan.id, businessDateStr, needed]
      );
      for (const r of schedRes.rows) {
        consideredRepayDates.push(r.bd_date);
      }
    }

    let param4Score = null;
    let param4Label = null;
    let withdrawalsBeforeRepayCount = 0;
    let minDaysBeforeRepayment = null;

    if (consideredRepayDates.length >= installmentsToConsider) {
      const sortedDates = [...consideredRepayDates].sort();
      const p4WindowStart = sortedDates[0];
      const p4WindowEnd = sortedDates[sortedDates.length - 1];

      const withdrRes = await client.query(
        `
        SELECT TO_CHAR(s.transaction_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS bd_date,
               s.withdrawal_amount, s.trx_type
        FROM savings_account_transaction s
        LEFT JOIN savings_account sa
          ON sa.id = s.savings_account_id
         AND sa.office_info_id = s.office_info_id
        WHERE s.office_info_id = $1
          AND s.member_info_id = $2
          AND ($5::bigint IS NULL OR sa.account_type_id = $5::bigint)
          AND s.domain_status_id = 1
          AND s.trx_type != 4
          AND s.withdrawal_amount > 0
          AND (s.transaction_date AT TIME ZONE 'Asia/Dhaka')::date >= $3::date
          AND (s.transaction_date AT TIME ZONE 'Asia/Dhaka')::date <= $4::date
        ORDER BY bd_date DESC
        `,
        [officeId, memberId, p4WindowStart, p4WindowEnd, p4SavType]
      );

      for (const w of withdrRes.rows) {
        let closestGapForWithdrawal = null;
        for (const rDate of consideredRepayDates) {
          if (w.bd_date <= rDate) {
            const gap = diffDays(w.bd_date, rDate);
            if (closestGapForWithdrawal === null || gap < closestGapForWithdrawal) {
              closestGapForWithdrawal = gap;
            }
          }
        }
        if (closestGapForWithdrawal !== null) {
          withdrawalsBeforeRepayCount += 1;
          if (minDaysBeforeRepayment === null || closestGapForWithdrawal < minDaysBeforeRepayment) {
            minDaysBeforeRepayment = closestGapForWithdrawal;
          }
        }
      }

      let p4Seq = 1;
      if (withdrawalsBeforeRepayCount === 0) {
        p4Seq = 1;
      } else if (minDaysBeforeRepayment !== null && minDaysBeforeRepayment <= daysBeforeRepayment) {
        p4Seq = 3;
      } else {
        p4Seq = 2;
      }

      const fallbackP4 =
        p4Seq === 1
          ? { score: 5, label: 'Never withdrew' }
          : p4Seq === 3
          ? { score: 3, label: `Withdrew within ${daysBeforeRepayment} days` }
          : { score: 4, label: `Withdrew before ${daysBeforeRepayment} days` };

      const matchedP4 = matchSeqBand(
        bands,
        'SAVINGS_WITHDRAWAL_BEFORE_REPAYMENT',
        projectId,
        p4Seq,
        fallbackP4
      );
      param4Score = matchedP4.score;
      param4Label = matchedP4.label;
    }

    // Final Score
    const reqFinalScore = Number(this.config.required_final_score || 3.0);
    let finalScore = null;
    let step5Pass = false;
    let step5Reason = null;

    if (
      param1Score === null ||
      param2Score === null ||
      param3Score === null ||
      param4Score === null
    ) {
      finalScore = null;
      step5Pass = false;
      step5Reason = 'Score could not be computed (no scoring data)';
    } else {
      finalScore = Number(
        ((param1Score + param2Score + param3Score + param4Score) / 4).toFixed(3)
      );
      if (toggles.FINAL_SCORE === false) {
        step5Pass = true;
      } else {
        step5Pass = finalScore >= reqFinalScore;
        step5Reason = step5Pass
          ? null
          : `Final score ${finalScore} below required ${reqFinalScore}`;
      }
    }

    const step5Result = {
      step: 5,
      name: 'Credit Scoring & Final Score',
      param1: {
        code: 'INSTALLMENT_PAYMENT_BEHAVIOR',
        score: param1Score !== null ? Number(param1Score.toFixed(3)) : null,
        details: param1Details
      },
      param2: {
        code: 'SAVINGS_PAID_WITH_INSTALLMENT',
        score: param2Score !== null ? Number(param2Score.toFixed(3)) : null,
        details: param2Details
      },
      param3: {
        code: 'SAVINGS_ADJUSTMENT_PREV_LOAN',
        score: param3Score !== null ? Number(param3Score.toFixed(3)) : null,
        details: param3Details
      },
      param4: {
        code: 'SAVINGS_WITHDRAWAL_BEFORE_REPAYMENT',
        score: param4Score !== null ? Number(param4Score.toFixed(3)) : null,
        label: param4Label || 'Insufficient installment history',
        withdrawalCount: withdrawalsBeforeRepayCount,
        closestGap: minDaysBeforeRepayment,
        installmentsFound: consideredRepayDates.length,
        installmentsToConsider,
        daysBeforeRepayment
      },
      finalScore,
      requiredScore: reqFinalScore,
      passed: step5Pass,
      reason: step5Reason,
      qaFindings
    };

    // Overall Eligibility (Logical CR step order 1 -> 2 -> 3 -> 4 -> 5)
    let overallPassed = true;
    let failedStep = null;
    let failedReason = null;

    if (!step1Result.passed) {
      overallPassed = false;
      failedStep = 1;
      failedReason = step1Result.reason;
    } else if (!step2Result.passed) {
      overallPassed = false;
      failedStep = 2;
      failedReason = step2Result.reason;
    } else if (!step3Result.passed) {
      overallPassed = false;
      failedStep = 3;
      failedReason = step3Result.reason;
    } else if (!step4Result.passed) {
      overallPassed = false;
      failedStep = 4;
      failedReason = step4Result.reason;
    } else if (!step5Result.passed) {
      overallPassed = false;
      failedStep = 5;
      failedReason = step5Result.reason;
    }

    // ----------------------------------------------------
    // SYSTEM STORED RECORDS CHECK (QA RECONCILIATION)
    // ----------------------------------------------------
    const targetRunId = this.latestRun ? Number(this.latestRun.id) : null;

    const dbEligRes = targetRunId
      ? await client.query(
          'SELECT * FROM credit_risk_model_eligible_member WHERE member_id = $1 AND run_id = $2 ORDER BY id DESC LIMIT 1',
          [memberId, targetRunId]
        )
      : await client.query(
          'SELECT * FROM credit_risk_model_eligible_member WHERE member_id = $1 ORDER BY run_id DESC, id DESC LIMIT 1',
          [memberId]
        );

    const dbCandRes = targetRunId
      ? await client.query(
          'SELECT * FROM credit_risk_model_eligibility_candidate WHERE member_id = $1 AND run_id = $2 ORDER BY id DESC LIMIT 1',
          [memberId, targetRunId]
        )
      : await client.query(
          'SELECT * FROM credit_risk_model_eligibility_candidate WHERE member_id = $1 ORDER BY run_id DESC, id DESC LIMIT 1',
          [memberId]
        );

    const dbScoreRes = targetRunId
      ? await client.query(
          'SELECT * FROM credit_risk_model_eligibility_score_detail WHERE member_id = $1 AND run_id = $2 ORDER BY parameter_code, loan_account_id',
          [memberId, targetRunId]
        )
      : await client.query(
          'SELECT * FROM credit_risk_model_eligibility_score_detail WHERE member_id = $1 ORDER BY parameter_code, loan_account_id',
          [memberId]
        );

    const systemRecord = {
      foundInEligibleTable: dbEligRes.rows.length > 0,
      eligibleRow: dbEligRes.rows[0] || null,
      foundInCandidateTable: dbCandRes.rows.length > 0,
      candidateRow: dbCandRes.rows[0] || null,
      scoreDetails: dbScoreRes.rows
    };

    const evaluation = {
      businessDate: businessDateStr,
      step1: step1Result,
      step2: step2Result,
      step3: step3Result,
      step4: step4Result,
      step5: step5Result,
      overallStatus: overallPassed ? 'ELIGIBLE' : 'NOT_ELIGIBLE',
      failedStep,
      failedReason,
      minEligibleAmount: step4Result.minEligibleAmount,
      maxEligibleAmount: step4Pass
        ? step4Result.maxEligibleAmount
        : Math.min(step4Result.computedCeiling, projectCap.max_amount),
      finalScore
    };

    if (systemRecord.foundInEligibleTable && systemRecord.eligibleRow.final_score !== null) {
      const row = systemRecord.eligibleRow;
      evaluation.systemFinalScore = Number(row.final_score);
      evaluation.systemParam1Score = Number(row.param1_score);
      evaluation.systemParam2Score = Number(row.param2_score);
      evaluation.systemParam3Score = Number(row.param3_score);
      evaluation.systemParam4Score = Number(row.param4_score);
      evaluation.systemMaxEligibleAmount = Number(row.max_eligible_amount);
      evaluation.systemMinEligibleAmount = Number(row.min_eligible_amount);
      evaluation.systemEligibilityStatus = row.eligibility_status;
    }

    return {
      environment: this.buildEnvironmentSummary(),
      applicableProductInfo,
      officeMismatchWarning,
      member: {
        id: member.id,
        memberNo: member.member_no,
        referenceNo: member.reference_no || null,
        name: member.member_name,
        branchId: member.branch_info_id,
        branchCode: member.office_code,
        branchName: member.office_name,
        projectId: member.project_info_id,
        projectName: member.project_name
      },
      evaluation,
      allGeneralLoans: allGeneralLoans.map((l) => ({
        id: l.id,
        accountNo: l.account_no,
        officeInfoId: l.office_info_id,
        statusId: l.loan_status_id,
        disbursedAmount: Number(l.disbursed_amount),
        outstandingBalance: Number(l.outstanding_balance),
        disbursementDate: l.disb_date_bd || toDhakaDateStr(l.disbursement_date)
      })),
      systemRecord
    };
  }

  buildEnvironmentSummary() {
    return {
      configPath: this.appConfig.configPath,
      baseUrl: this.appConfig.erp.baseUrl,
      eligibilityReportUrl: this.appConfig.erp.eligibilityReportUrl,
      assessmentConfigUrl: this.appConfig.erp.assessmentConfigUrl,
      credentialValidation: this.credentialValidation,
      configuredOffice: this.configuredOffice,
      branchUser: this.appConfig.credentials.branch.username,
      headOfficeUser: this.appConfig.credentials.headOffice.username,
      configuredLoanProducts: this.configuredLoanProducts,
      liveConfig: this.config,
      latestRun: this.latestRun
        ? {
            id: Number(this.latestRun.id),
            status: this.latestRun.run_status,
            businessDate: this.latestRun.config_snapshot?._business_date || null,
            endedAt: this.latestRun.ended_at ? new Date(this.latestRun.ended_at).toISOString() : null
          }
        : null,
      configDrift: this.configDrift
    };
  }
}

module.exports = { NanoLoanEvaluator, scoreLoanInstallmentBehavior };