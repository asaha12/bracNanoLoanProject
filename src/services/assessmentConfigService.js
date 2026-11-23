/**
 * Live Credit Risk Model Assessment Configuration Service
 * Reads active (domain_status_id = 1) configuration tables fresh on every run,
 * resolves the latest eligibility batch run for reconciliation, and detects
 * configuration drift between live DB rules / loan product settings and the last batch snapshot.
 */

const DEFAULT_FALLBACK_CONFIG = {
  business_date: '2026-10-31',
  history_years: 4,
  minimum_loan_cycle: 2,
  loans_to_select: 2,
  number_of_loans_to_avg: 2,
  eligible_loan_percentage: 20,
  required_paid_percentage: 30,
  required_final_score: 3.0,
  due_month_evaluation_period: 12,
  due_month_evaluation_period_unit: 'MONTH',
  due_month_evaluation_rule: 'WITHIN_THE_MONTH',
  installments_to_consider: 11,
  days_before_repayment: 7,
  general_loan_product_ids: [
    42, 46, 76, 79, 80, 96, 97, 100, 102, 103, 119, 126, 133, 134, 143, 145, 146,
    180, 181, 183, 184, 185, 188, 224, 225, 226, 227, 228, 230
  ],
  project_ceilings: [
    { project_info_id: 1, project: 'Microfinance (Dabi)', min_amount: 20000, max_amount: 50000 },
    { project_info_id: 2, project: 'Progoti', min_amount: 20000, max_amount: 100000 }
  ]
};

async function loadLatestBatchRun(client, requestedRunId) {
  if (requestedRunId && requestedRunId !== 'latest') {
    const res = await client.query(
      'SELECT * FROM credit_risk_model_eligibility_run WHERE id = $1',
      [Number(requestedRunId)]
    );
    if (res.rows.length > 0) return res.rows[0];
  }

  const latestRes = await client.query(
    'SELECT * FROM credit_risk_model_eligibility_run ORDER BY id DESC LIMIT 1'
  );
  return latestRes.rows[0] || null;
}

function buildConfigDriftReport(liveConfig, snapshot, configuredProducts) {
  const drifts = [];
  if (!snapshot) return drifts;

  const compare = (label, liveVal, snapVal) => {
    if (snapVal === undefined || snapVal === null || liveVal === undefined || liveVal === null) return;
    if (Number(liveVal) !== Number(snapVal) && String(liveVal) !== String(snapVal)) {
      drifts.push({
        field: label,
        liveValue: liveVal,
        snapshotValue: snapVal
      });
    }
  };

  compare('minimum_loan_cycle', liveConfig.minimum_loan_cycle, snapshot.minimum_loan_cycle);
  compare('history_years', liveConfig.history_years, snapshot.history_years);
  compare('required_paid_percentage', liveConfig.required_paid_percentage, snapshot.required_paid_percentage);
  compare('due_month_evaluation_period', liveConfig.due_month_evaluation_period, snapshot.due_month_evaluation_period);
  compare('due_month_evaluation_period_unit', liveConfig.due_month_evaluation_period_unit, snapshot.due_month_evaluation_period_unit);
  compare('number_of_loans_to_avg', liveConfig.number_of_loans_to_avg, snapshot.number_of_loans_to_avg);
  compare('eligible_loan_percentage', liveConfig.eligible_loan_percentage, snapshot.eligible_loan_percentage);
  compare('required_final_score', liveConfig.required_final_score, snapshot.required_final_score);

  // Compare live Loan Product ceilings vs snapshot project_ceilings
  const snapCeilings = snapshot.project_ceilings || [];
  for (const prod of configuredProducts || []) {
    if (!prod.found || !prod.primaryProjectId) continue;
    const snapCap = snapCeilings.find((c) => Number(c.project_info_id) === prod.primaryProjectId);
    if (snapCap) {
      compare(
        `Loan Product ${prod.id} (${prod.loanName}) min_loan_amount`,
        prod.minLoanAmount,
        snapCap.min_amount
      );
      compare(
        `Loan Product ${prod.id} (${prod.loanName}) max_loan_amount`,
        prod.maxLoanAmount,
        snapCap.max_amount
      );
    }
  }

  return drifts;
}

/**
 * Loads live credit risk model configuration from all active conf tables
 * plus the latest eligibility batch run for business date & drift comparison.
 */
async function loadLiveAssessmentConfig(client, appConfig, configuredProducts = []) {
  const minCycleRes = await client.query(
    'SELECT * FROM credit_risk_model_conf_min_loan_cycle WHERE domain_status_id = 1 ORDER BY id DESC LIMIT 1'
  );
  const runningRepayRes = await client.query(
    'SELECT * FROM credit_risk_model_conf_running_repayment WHERE domain_status_id = 1 ORDER BY id DESC LIMIT 1'
  );
  const dueMonthRes = await client.query(
    'SELECT * FROM credit_risk_model_conf_due_month_repayment WHERE domain_status_id = 1 ORDER BY id DESC LIMIT 1'
  );
  const loanAmtRes = await client.query(
    'SELECT * FROM credit_risk_model_conf_loan_amount_calc WHERE domain_status_id = 1 ORDER BY id DESC LIMIT 1'
  );
  const finalScoreRes = await client.query(
    'SELECT * FROM credit_risk_model_conf_final_score WHERE domain_status_id = 1 ORDER BY id DESC LIMIT 1'
  );
  const paramConfRes = await client.query(
    'SELECT * FROM credit_risk_model_conf_credit_score_parameter WHERE domain_status_id = 1 ORDER BY id DESC'
  );
  const scoreBandRes = await client.query(
    `
    SELECT * FROM credit_risk_model_conf_credit_score_band
    WHERE domain_status_id = 1
    ORDER BY parameter_code, project_info_id NULLS FIRST, band_seq ASC
    `
  );
  const generalLoanMapRes = await client.query(
    'SELECT loan_product_id, project_info_id FROM credit_risk_model_conf_general_loan_map WHERE domain_status_id = 1 ORDER BY loan_product_id'
  );
  const latestRun = await loadLatestBatchRun(client, appConfig.evaluation.runId);

  const snapshot = latestRun && latestRun.config_snapshot ? latestRun.config_snapshot : null;

  const minCycleRow = minCycleRes.rows[0] || null;
  const runningRepayRow = runningRepayRes.rows[0] || null;
  const dueMonthRow = dueMonthRes.rows[0] || null;
  const loanAmtRow = loanAmtRes.rows[0] || null;
  const finalScoreRow = finalScoreRes.rows[0] || null;

  const generalLoanProductIds =
    generalLoanMapRes.rows.length > 0
      ? [...new Set(generalLoanMapRes.rows.map((r) => Number(r.loan_product_id)))]
      : (snapshot && snapshot.general_loan_product_ids) || DEFAULT_FALLBACK_CONFIG.general_loan_product_ids;

  const businessDate =
    appConfig.evaluation.businessDate ||
    (snapshot && snapshot._business_date) ||
    DEFAULT_FALLBACK_CONFIG.business_date;

  // Build project ceilings starting from snapshot/defaults, then overriding with live configured loan products
  const ceilingMap = new Map();
  const baseCeilings =
    (snapshot && snapshot.project_ceilings) || DEFAULT_FALLBACK_CONFIG.project_ceilings;

  for (const c of baseCeilings) {
    ceilingMap.set(Number(c.project_info_id), {
      project_info_id: Number(c.project_info_id),
      project: c.project,
      min_amount: Number(c.min_amount),
      max_amount: Number(c.max_amount),
      source: snapshot ? `Batch Run #${latestRun.id} Snapshot` : 'Default Fallback'
    });
  }

  for (const prod of configuredProducts) {
    if (prod.found && prod.primaryProjectId && prod.minLoanAmount !== null && prod.maxLoanAmount !== null) {
      ceilingMap.set(prod.primaryProjectId, {
        project_info_id: prod.primaryProjectId,
        project: prod.primaryProjectName || prod.loanName,
        min_amount: prod.minLoanAmount,
        max_amount: prod.maxLoanAmount,
        loan_product_id: prod.id,
        loan_product_name: prod.loanName,
        source: `Live Loan Product #${prod.id} (${prod.loanName})`
      });
    }
  }

  // Extract live score parameters & bands
  const scoreParameters = paramConfRes.rows.map((r) => ({
    id: Number(r.id),
    parameterCode: r.parameter_code,
    projectInfoId: r.project_info_id !== null ? Number(r.project_info_id) : null,
    frequencyId: r.frequency_id !== null ? Number(r.frequency_id) : null,
    loanCount: r.loan_count !== null ? Number(r.loan_count) : null,
    loanAccStatus: r.loan_acc_status,
    savingsToConsiderId: r.savings_to_consider_id !== null ? Number(r.savings_to_consider_id) : null,
    frequencyNoToConsider: r.frequency_no_to_consider !== null ? Number(r.frequency_no_to_consider) : null,
    daysBeforeRepayment: r.days_before_repayment !== null ? Number(r.days_before_repayment) : null
  }));

  const scoreBands =
    scoreBandRes.rows.length > 0
      ? scoreBandRes.rows.map((b) => ({
          parameterCode: b.parameter_code,
          projectInfoId: b.project_info_id !== null ? Number(b.project_info_id) : null,
          bandSeq: Number(b.band_seq),
          bandLabel: b.band_label,
          lowerBound: b.lower_bound !== null ? Number(b.lower_bound) : null,
          upperBound: b.upper_bound !== null ? Number(b.upper_bound) : null,
          lowerInclusive: Boolean(b.lower_inclusive),
          upperInclusive: Boolean(b.upper_inclusive),
          scoreValue: Number(b.score_value)
        }))
      : (snapshot && snapshot.score_bands) || [];

  const liveConfig = {
    source: 'LIVE_DATABASE_TABLES',
    loadedAt: new Date().toISOString(),
    business_date: businessDate,
    minimum_loan_cycle: minCycleRow
      ? Number(minCycleRow.minimum_loan_cycle)
      : (snapshot && snapshot.minimum_loan_cycle) || DEFAULT_FALLBACK_CONFIG.minimum_loan_cycle,
    history_years: minCycleRow
      ? Number(minCycleRow.history_years)
      : (snapshot && snapshot.history_years) || DEFAULT_FALLBACK_CONFIG.history_years,
    frequency_id: minCycleRow
      ? Number(minCycleRow.frequency_id)
      : (snapshot && snapshot.frequency_id) || 3,
    required_paid_percentage: runningRepayRow
      ? Number(runningRepayRow.required_paid_percentage)
      : (snapshot && snapshot.required_paid_percentage) || DEFAULT_FALLBACK_CONFIG.required_paid_percentage,
    due_month_evaluation_period: dueMonthRow
      ? Number(dueMonthRow.evaluation_period)
      : (snapshot && snapshot.due_month_evaluation_period) || DEFAULT_FALLBACK_CONFIG.due_month_evaluation_period,
    due_month_evaluation_period_unit: dueMonthRow
      ? dueMonthRow.period_unit
      : (snapshot && snapshot.due_month_evaluation_period_unit) || DEFAULT_FALLBACK_CONFIG.due_month_evaluation_period_unit,
    due_month_evaluation_rule: dueMonthRow
      ? dueMonthRow.evaluation_rule
      : DEFAULT_FALLBACK_CONFIG.due_month_evaluation_rule,
    number_of_loans_to_avg: loanAmtRow
      ? Number(loanAmtRow.number_of_loans_to_avg)
      : (snapshot && snapshot.number_of_loans_to_avg) || DEFAULT_FALLBACK_CONFIG.number_of_loans_to_avg,
    eligible_loan_percentage: loanAmtRow
      ? Number(loanAmtRow.eligible_loan_percentage)
      : (snapshot && snapshot.eligible_loan_percentage) || DEFAULT_FALLBACK_CONFIG.eligible_loan_percentage,
    required_final_score: finalScoreRow
      ? Number(finalScoreRow.required_final_score)
      : (snapshot && snapshot.required_final_score) || DEFAULT_FALLBACK_CONFIG.required_final_score,
    general_loan_product_ids: generalLoanProductIds,
    project_ceilings: Array.from(ceilingMap.values()),
    score_parameters: scoreParameters,
    score_bands: scoreBands
  };

  const configDrift = buildConfigDriftReport(liveConfig, snapshot, configuredProducts);

  return {
    liveConfig,
    latestRun,
    configDrift
  };
}

module.exports = { loadLiveAssessmentConfig, DEFAULT_FALLBACK_CONFIG };
