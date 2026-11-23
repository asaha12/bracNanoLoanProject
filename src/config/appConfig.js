const path = require('path');
const { parsePropertiesFile } = require('./propertiesParser');

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '../../config/config.properties');

/**
 * Extracts a numeric loan product ID from either a raw ID ("235")
 * or a full ERP URL ("https://.../loanProduct/show/id=235").
 */
function extractLoanProductId(token, propName = 'loan.product.id') {
  const cleaned = String(token || '').trim();
  if (!cleaned) return null;

  const urlMatch = cleaned.match(/id=(\d+)/i);
  if (urlMatch) {
    return Number(urlMatch[1]);
  }

  if (/^\d+$/.test(cleaned)) {
    return Number(cleaned);
  }

  throw new Error(
    `Invalid ${propName} entry "${cleaned}". Expected a numeric ID (e.g. 235) or URL ending in id=<number>.`
  );
}

function requireProp(props, key) {
  const val = props[key];
  if (val === undefined || val === '') {
    throw new Error(`Missing required configuration property: "${key}"`);
  }
  return val;
}

/**
 * Loads and validates application configuration from config/config.properties.
 * Called fresh on every execution so changes to config.properties take effect immediately.
 *
 * @param {string} [customPath] - Optional override path to a .properties file.
 */
function loadAppConfig(customPath) {
  const configPath = customPath || process.env.CONFIG_PROPERTIES_PATH || DEFAULT_CONFIG_PATH;
  const raw = parsePropertiesFile(configPath);

  const baseUrl = requireProp(raw, 'base.url').replace(/\/+$/, '');

  const getLoanProductUrl = (id) =>
    `${baseUrl}/node/mfDashboard#!/loanProduct/show/id=${id}`;

  const dabiProductRaw = requireProp(raw, 'loan.product.dabi.id');
  const progotiProductRaw = requireProp(raw, 'loan.product.progoti.id');

  const dabiLoanProductId = extractLoanProductId(dabiProductRaw, 'loan.product.dabi.id');
  const progotiLoanProductId = extractLoanProductId(progotiProductRaw, 'loan.product.progoti.id');

  const loanProducts = {
    dabi: {
      key: 'dabi',
      propertyName: 'loan.product.dabi.id',
      label: 'Dabi',
      expectedProjectId: 1,
      id: dabiLoanProductId,
      url: getLoanProductUrl(dabiLoanProductId)
    },
    progoti: {
      key: 'progoti',
      propertyName: 'loan.product.progoti.id',
      label: 'Progoti',
      expectedProjectId: 2,
      id: progotiLoanProductId,
      url: getLoanProductUrl(progotiLoanProductId)
    }
  };

  const loanProductSpecs = [loanProducts.dabi, loanProducts.progoti];
  const loanProductIds = [...new Set(loanProductSpecs.map((s) => s.id))];

  const officeIdRaw = requireProp(raw, 'office.id');
  const officeId = Number(officeIdRaw);
  if (!Number.isInteger(officeId) || officeId <= 0) {
    throw new Error(`Invalid office.id "${officeIdRaw}". Expected a positive integer.`);
  }

  const branchOfficeCode = requireProp(raw, 'branch.office.code');
  const branchUsername = requireProp(raw, 'branch.username');
  const branchPassword = requireProp(raw, 'branch.password');

  const headOfficeUsername = requireProp(raw, 'head.office.username');
  const headOfficePassword = requireProp(raw, 'head.office.password');

  const dbHost = requireProp(raw, 'db.host');
  const dbPort = Number(requireProp(raw, 'db.port'));
  const dbName = requireProp(raw, 'db.name');
  const dbUser = requireProp(raw, 'db.user');
  const dbPassword = requireProp(raw, 'db.password');
  const dbTimeoutMs = Number(raw['db.connection.timeout.ms'] || 10000);

  const businessDateOverride = raw['evaluation.business.date'] || null;
  const runIdRaw = (raw['eligibility.run.id'] || 'latest').toLowerCase();
  const eligibilityRunId = runIdRaw === 'latest' || runIdRaw === '' ? 'latest' : Number(runIdRaw);

  return {
    configPath,
    erp: {
      baseUrl,
      loanProducts,
      loanProductSpecs,
      loanProductIds,
      getLoanProductUrl,
      eligibilityReportUrl: `${baseUrl}/node/mfDashboard#!/microfinanceReport/nanoLoanEligibilityReport`,
      assessmentConfigUrl: `${baseUrl}/node/mfDashboard#!/creditEligibilityAssessmentConf/create`
    },
    office: {
      id: officeId,
      branchCode: branchOfficeCode
    },
    credentials: {
      branch: {
        officeCode: branchOfficeCode,
        username: branchUsername,
        password: branchPassword
      },
      headOffice: {
        username: headOfficeUsername,
        password: headOfficePassword
      }
    },
    db: {
      host: dbHost,
      port: dbPort,
      database: dbName,
      user: dbUser,
      password: dbPassword,
      connectionTimeoutMillis: dbTimeoutMs
    },
    evaluation: {
      businessDate: businessDateOverride,
      runId: eligibilityRunId
    }
  };
}

module.exports = { loadAppConfig, DEFAULT_CONFIG_PATH, extractLoanProductId };
