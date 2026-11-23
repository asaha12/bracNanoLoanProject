/**
 * Live Loan Product Configuration Service
 * Always queries the database fresh on every run so newly created or modified
 * loan products (e.g., .../loanProduct/show/id=235) are checked in real time.
 */

function formatDateOnly(val) {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? String(val) : d.toISOString().split('T')[0];
}

async function fetchLoanProductConfig(client, productId, appConfig, spec = null) {
  const url = appConfig.erp.getLoanProductUrl(productId);

  const lpRes = await client.query(
    `
    SELECT id, version, loan_code, loan_name, product_short_name, code_short_name,
           loan_product_type_id, domain_status_id, loan_effective_date, loan_setup_date,
           end_date, last_updated, has_parallel_loan, is_insurance_allowed,
           is_insurance_required, collection_on_disbursement_month, map_type
    FROM loan_product
    WHERE id = $1
    `,
    [productId]
  );

  if (lpRes.rows.length === 0) {
    return {
      found: false,
      id: Number(productId),
      url,
      configKey: spec ? spec.key : null,
      propertyName: spec ? spec.propertyName : null,
      expectedProjectId: spec ? spec.expectedProjectId : null,
      expectedLabel: spec ? spec.label : null,
      projectMappingVerified: false,
      error: `Loan Product ID ${productId} does not exist in loan_product table.`
    };
  }

  const lp = lpRes.rows[0];

  const projRes = await client.query(
    `
    SELECT plpm.project_info_id, pi.project_code, pi.project_name, plpm.domain_status_id
    FROM project_loan_product_mapping plpm
    LEFT JOIN project_info pi ON pi.id = plpm.project_info_id
    WHERE plpm.loan_product_id = $1 AND plpm.domain_status_id = 1
    ORDER BY plpm.id DESC
    `,
    [productId]
  );

  const rateRes = await client.query(
    `
    SELECT id, loan_interest_rate, min_loan_amount, max_loan_amount,
           effective_date, end_date, last_updated, domain_status_id
    FROM loan_product_interest_rate
    WHERE loan_product_id = $1 AND domain_status_id = 1
    ORDER BY id DESC
    `,
    [productId]
  );

  const policyRes = await client.query(
    `
    SELECT id, loan_product_details_id, policy_minimum_loan_amount, policy_maximum_loan_amount,
           policy_grace_period_in_days, policy_repayments_plan_id,
           effective_date, end_date, domain_status_id
    FROM loan_product_policy
    WHERE loan_product_id = $1 AND domain_status_id = 1
    ORDER BY id DESC
    `,
    [productId]
  );

  const detailsRes = await client.query(
    `
    SELECT id, duration_in_months, no_of_installment, frequency_id,
           effective_date, end_date, domain_status_id
    FROM loan_product_details
    WHERE loan_product_id = $1 AND domain_status_id = 1
    ORDER BY duration_in_months ASC, id DESC
    `,
    [productId]
  );

  const mappedProjects = projRes.rows.map((r) => ({
    projectInfoId: Number(r.project_info_id),
    projectCode: r.project_code,
    projectName: r.project_name
  }));

  const activeRate = rateRes.rows[0] || null;
  const activePolicies = policyRes.rows;

  const policyMinAmounts = activePolicies
    .map((p) => Number(p.policy_minimum_loan_amount))
    .filter((v) => !Number.isNaN(v) && v > 0);
  const policyMaxAmounts = activePolicies
    .map((p) => Number(p.policy_maximum_loan_amount))
    .filter((v) => !Number.isNaN(v) && v > 0);

  const policyMinAmount = policyMinAmounts.length > 0 ? Math.min(...policyMinAmounts) : null;
  const policyMaxAmount = policyMaxAmounts.length > 0 ? Math.max(...policyMaxAmounts) : null;

  const interestRateMinAmount = activeRate ? Number(activeRate.min_loan_amount) : null;
  const interestRateMaxAmount = activeRate ? Number(activeRate.max_loan_amount) : null;

  // Authoritative loan product ceiling: active interest rate slab min/max (matches ERP loan product screen),
  // falling back to loan_product_policy if no active interest rate slab exists.
  const minLoanAmount = interestRateMinAmount !== null ? interestRateMinAmount : policyMinAmount;
  const maxLoanAmount = interestRateMaxAmount !== null ? interestRateMaxAmount : policyMaxAmount;

  const tenures = detailsRes.rows.map((d) => ({
    id: Number(d.id),
    durationInMonths: Number(d.duration_in_months),
    noOfInstallments: Number(d.no_of_installment),
    frequencyId: Number(d.frequency_id),
    effectiveDate: formatDateOnly(d.effective_date),
    endDate: formatDateOnly(d.end_date)
  }));

  const warnings = [];
  if (Number(lp.domain_status_id) !== 1) {
    warnings.push(`Loan product ${productId} is NOT active (domain_status_id = ${lp.domain_status_id}).`);
  }
  if (mappedProjects.length === 0) {
    warnings.push(`Loan product ${productId} has no active project mapping in project_loan_product_mapping.`);
  }
  if (!activeRate) {
    warnings.push(`Loan product ${productId} has no active row in loan_product_interest_rate.`);
  }
  if (
    interestRateMaxAmount !== null &&
    policyMaxAmount !== null &&
    interestRateMaxAmount !== policyMaxAmount
  ) {
    warnings.push(
      `Ceiling note: loan_product_interest_rate max (${interestRateMaxAmount}) differs from loan_product_policy max (${policyMaxAmount}). Using interest_rate slab ceiling (${interestRateMaxAmount}).`
    );
  }

  const projectMappingVerified = spec
    ? mappedProjects.some((mp) => mp.projectInfoId === spec.expectedProjectId)
    : mappedProjects.length > 0;

  if (spec && !projectMappingVerified) {
    const actualProjects =
      mappedProjects.length > 0
        ? mappedProjects.map((p) => `${p.projectName} (ID: ${p.projectInfoId})`).join(', ')
        : 'NONE';
    warnings.push(
      `Project mismatch: ${spec.propertyName}=${productId} is expected for ${spec.label} (Project ID: ${spec.expectedProjectId}), but DB maps it to [${actualProjects}].`
    );
  }

  return {
    found: true,
    id: Number(lp.id),
    version: Number(lp.version),
    url,
    configKey: spec ? spec.key : null,
    propertyName: spec ? spec.propertyName : null,
    expectedProjectId: spec ? spec.expectedProjectId : null,
    expectedLabel: spec ? spec.label : null,
    projectMappingVerified,
    loanCode: lp.loan_code,
    loanName: lp.loan_name,
    shortName: lp.product_short_name || lp.code_short_name,
    loanProductTypeId: Number(lp.loan_product_type_id),
    domainStatusId: Number(lp.domain_status_id),
    isActive: Number(lp.domain_status_id) === 1,
    effectiveDate: formatDateOnly(lp.loan_effective_date),
    endDate: formatDateOnly(lp.end_date),
    lastUpdated: lp.last_updated ? new Date(lp.last_updated).toISOString() : null,
    hasParallelLoan: Boolean(lp.has_parallel_loan),
    isInsuranceAllowed: Boolean(lp.is_insurance_allowed),
    isInsuranceRequired: Boolean(lp.is_insurance_required),
    collectionOnDisbursementMonth: Boolean(lp.collection_on_disbursement_month),
    mappedProjects,
    primaryProjectId: mappedProjects.length > 0 ? mappedProjects[0].projectInfoId : null,
    primaryProjectName: mappedProjects.length > 0 ? mappedProjects[0].projectName : null,
    interestRate: activeRate ? Number(activeRate.loan_interest_rate) : null,
    interestRateMinAmount,
    interestRateMaxAmount,
    policyMinAmount,
    policyMaxAmount,
    gracePeriodDays: activePolicies.length > 0 ? Number(activePolicies[0].policy_grace_period_in_days) : null,
    minLoanAmount,
    maxLoanAmount,
    tenures,
    warnings
  };
}

async function fetchConfiguredLoanProducts(client, appConfig) {
  const products = [];
  for (const spec of appConfig.erp.loanProductSpecs) {
    const prod = await fetchLoanProductConfig(client, spec.id, appConfig, spec);
    products.push(prod);
  }
  return products;
}

/**
 * Finds the latest active Nano Loan product (loan_product_type_id = 32) mapped to a given project.
 * Used when the evaluated member belongs to a project different from the single ID configured in config.properties.
 */
async function fetchActiveNanoLoanProductByProject(client, projectId, appConfig) {
  const res = await client.query(
    `
    SELECT lp.id
    FROM loan_product lp
    JOIN project_loan_product_mapping plpm
      ON plpm.loan_product_id = lp.id AND plpm.domain_status_id = 1
    WHERE lp.domain_status_id = 1
      AND plpm.project_info_id = $1
      AND (lp.loan_product_type_id = 32 OR lp.loan_name ILIKE '%nano%')
    ORDER BY lp.id DESC
    LIMIT 1
    `,
    [projectId]
  );

  if (res.rows.length === 0) {
    return null;
  }

  return fetchLoanProductConfig(client, Number(res.rows[0].id), appConfig);
}

module.exports = {
  fetchLoanProductConfig,
  fetchConfiguredLoanProducts,
  fetchActiveNanoLoanProductByProject
};
