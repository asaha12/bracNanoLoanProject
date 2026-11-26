/**
 * Office Lookup & Validation Service
 *
 * In BRAC ERP Microfinance, `member_info.branch_info_id`, `loan_account.office_info_id`,
 * and `office.id` in config.properties reference `physical_office_info.id`
 * (also exposed in `view_project_wise_office_hierarchy.branch_id`), NOT `office_info.id`.
 * Example: `physical_office_info.id = 342` -> `[0459] Monirampur`.
 */

function normalizeBranchCode(code) {
  const raw = String(code || '').trim();
  if (/^\d+$/.test(raw)) {
    return raw.replace(/^0+/, '') || '0';
  }
  return raw.toUpperCase();
}

async function fetchOfficeById(client, officeId) {
  const res = await client.query(
    `
    SELECT p.id,
           COALESCE(NULLIF(BTRIM(p.mf_branch_id), ''), p.office_code) AS branch_code,
           p.office_code,
           p.mf_branch_id,
           p.office_name,
           p.office_type_id,
           p.office_status_id,
           p.is_mf_office,
           h.area_code,
           h.area_name,
           h.region_name,
           h.division_name
    FROM physical_office_info p
    LEFT JOIN LATERAL (
      SELECT area_code, area_name, region_name, division_name
      FROM view_project_wise_office_hierarchy vh
      WHERE vh.branch_id = p.id
      ORDER BY vh.project_info_id ASC
      LIMIT 1
    ) h ON true
    WHERE p.id = $1
    `,
    [officeId]
  );
  return res.rows[0] || null;
}

async function fetchConfiguredOffice(client, appConfig) {
  const configuredOfficeId = appConfig.office.id;
  const configuredBranchCode = String(appConfig.office.branchCode || '').trim();

  const row = await fetchOfficeById(client, configuredOfficeId);

  if (!row) {
    throw new Error(
      `Configured office.id=${configuredOfficeId} was not found in physical_office_info. Please check office.id in config/config.properties.`
    );
  }

  const dbBranchCode = String(row.branch_code || row.office_code || '').trim();
  const codeMatches =
    dbBranchCode === configuredBranchCode ||
    normalizeBranchCode(dbBranchCode) === normalizeBranchCode(configuredBranchCode);

  if (!codeMatches) {
    // Look up which office.id actually owns configuredBranchCode to provide an actionable error
    const matchByCode = await client.query(
      `
      SELECT id, COALESCE(NULLIF(BTRIM(mf_branch_id), ''), office_code) AS branch_code, office_name
      FROM physical_office_info
      WHERE mf_branch_id = $1
         OR office_code = $1
         OR LTRIM(COALESCE(mf_branch_id, ''), '0') = LTRIM($1, '0')
      ORDER BY is_mf_office DESC NULLS LAST, id ASC
      LIMIT 1
      `,
      [configuredBranchCode]
    );

    const hint =
      matchByCode.rows.length > 0
        ? ` Branch code [${matchByCode.rows[0].branch_code}] ${matchByCode.rows[0].office_name} has office.id=${matchByCode.rows[0].id}.`
        : '';

    throw new Error(
      `Office configuration mismatch in config/config.properties: office.id=${configuredOfficeId} resolves to [${dbBranchCode}] ${row.office_name}, which does not match branch.office.code=${configuredBranchCode}.${hint}`
    );
  }

  return {
    found: true,
    id: Number(row.id),
    officeCode: dbBranchCode,
    officeName: row.office_name,
    officeTypeId: Number(row.office_type_id),
    areaCode: row.area_code || null,
    areaName: row.area_name || null,
    regionName: row.region_name || null,
    divisionName: row.division_name || null,
    configuredOfficeId,
    configuredBranchCode,
    codeMatches: true,
    warning: null
  };
}

module.exports = { fetchConfiguredOffice, fetchOfficeById };