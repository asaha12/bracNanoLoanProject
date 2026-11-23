/**
 * Office Lookup & Validation Service
 * Verifies the configured office.id and branch.office.code against office_info.
 */

async function fetchConfiguredOffice(client, appConfig) {
  const configuredOfficeId = appConfig.office.id;
  const configuredBranchCode = appConfig.office.branchCode;

  const res = await client.query(
    `
    SELECT id, office_code, office_name, office_type_id
    FROM office_info
    WHERE id = $1
    `,
    [configuredOfficeId]
  );

  if (res.rows.length === 0) {
    return {
      found: false,
      configuredOfficeId,
      configuredBranchCode,
      warning: `Configured office.id=${configuredOfficeId} was not found in office_info.`
    };
  }

  const row = res.rows[0];
  const dbOfficeCode = String(row.office_code || '');
  const codeMatches =
    dbOfficeCode === configuredBranchCode || dbOfficeCode.endsWith(configuredBranchCode);

  return {
    found: true,
    id: Number(row.id),
    officeCode: dbOfficeCode,
    officeName: row.office_name,
    officeTypeId: Number(row.office_type_id),
    configuredOfficeId,
    configuredBranchCode,
    codeMatches,
    warning: codeMatches
      ? null
      : `Configured branch.office.code (${configuredBranchCode}) does not match office_info.office_code (${dbOfficeCode}) for office.id=${configuredOfficeId}.`
  };
}

module.exports = { fetchConfiguredOffice };
