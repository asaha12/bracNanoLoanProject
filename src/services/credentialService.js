const https = require('https');
const http = require('http');

/**
 * Performs an HTTP/HTTPS request without external dependencies.
 */
function sendHttpRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      return reject(new Error(`Invalid URL "${urlStr}": ${err.message}`));
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeoutMs || 12000
    };

    if (isHttps) {
      reqOptions.rejectUnauthorized = false;
    }

    const req = transport.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body
        });
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out connecting to ${parsed.origin}`));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Authenticates a single user (Branch or Head Office) live against the BRAC ERP
 * Keycloak OIDC Identity Provider (`<base.url>/idp/realms/brac/...`).
 */
async function authenticateAgainstErpKeycloak(baseUrl, username, password, roleLabel) {
  // Step 1: Request ERP root to obtain fresh OIDC authorization redirect URL
  let rootRes;
  try {
    rootRes = await sendHttpRequest(`${baseUrl}/`, { method: 'GET' });
  } catch (err) {
    throw new Error(
      `Cannot reach ERP base.url (${baseUrl}) while validating ${roleLabel} credentials: ${err.message}`
    );
  }

  let authEntryUrl = rootRes.headers?.location;
  if (!authEntryUrl) {
    throw new Error(
      `Unexpected response from ${baseUrl}/ (HTTP ${rootRes.status}): missing Keycloak OIDC redirect.`
    );
  }
  if (!authEntryUrl.startsWith('http')) {
    authEntryUrl = `${baseUrl}${authEntryUrl.startsWith('/') ? '' : '/'}${authEntryUrl}`;
  }

  // Step 2: Load Keycloak login form + session cookies
  const loginPageRes = await sendHttpRequest(authEntryUrl, { method: 'GET' });
  if (loginPageRes.status !== 200 || !loginPageRes.body) {
    throw new Error(
      `Failed to load ERP Keycloak login page for ${roleLabel} (HTTP ${loginPageRes.status}).`
    );
  }

  const rawCookies = loginPageRes.headers['set-cookie'] || [];
  const cookieHeader = rawCookies.map((c) => c.split(';')[0]).join('; ');

  const actionMatch = loginPageRes.body.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/i) ||
    loginPageRes.body.match(/action="([^"]+login-actions\/authenticate[^"]+)"/i);

  if (!actionMatch) {
    throw new Error(`Could not locate Keycloak authentication form action at ${baseUrl}.`);
  }

  const actionUrl = actionMatch[1].replace(/&amp;/g, '&');
  const postBody = new URLSearchParams({
    username: String(username),
    password: String(password),
    credential: '',
    credentialId: '',
    login: 'Sign In'
  }).toString();

  // Step 3: Submit credentials to Keycloak
  const authRes = await sendHttpRequest(actionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postBody),
      Cookie: cookieHeader
    },
    body: postBody
  });

  const redirectLocation = authRes.headers?.location || '';
  const hasAuthCode =
    (authRes.status === 302 || authRes.status === 303) &&
    (/[?&]code=/.test(redirectLocation) || redirectLocation.startsWith(baseUrl));

  if (!hasAuthCode) {
    const feedbackMatch =
      authRes.body.match(/<span[^>]*class="[^"]*kc-feedback-text[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
      authRes.body.match(/<div[^>]*class="[^"]*alert-error[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const serverMsg = feedbackMatch
      ? feedbackMatch[1].replace(/<[^>]+>/g, '').trim().replace(/\.+$/, '')
      : 'Invalid username or password';

    throw new Error(
      `ERP Authentication FAILED for ${roleLabel} user "${username}" at ${baseUrl}: ${serverMsg}. Please verify credentials in config/config.properties.`
    );
  }

  return {
    authenticated: true,
    username
  };
}

/**
 * Looks up ERP application_user / view_applicationuser metadata (active/locked status, full name, designation).
 * Note: Numeric BRAC PINs (e.g. "97816") are stored zero-padded to 8 digits ("00097816") in application_user.
 */
async function verifyErpUserRecord(client, username, roleLabel) {
  const paddedPin = /^\d+$/.test(String(username))
    ? String(username).padStart(8, '0')
    : String(username);

  const res = await client.query(
    `
    SELECT u.id, u.username, u.full_name, u.enabled, u.account_locked,
           u.account_expired, u.password_expired, u.domain_status_id,
           vu.designation_name
    FROM application_user u
    LEFT JOIN view_applicationuser vu ON vu.user_id = u.id
    WHERE LOWER(u.username) = LOWER($1)
       OR LOWER(u.username) = LOWER($2)
    ORDER BY u.domain_status_id ASC, u.id DESC
    LIMIT 1
    `,
    [String(username), paddedPin]
  );

  if (res.rows.length === 0) {
    throw new Error(
      `ERP User "${username}" (${roleLabel}) was not found in application_user table.`
    );
  }

  const row = res.rows[0];
  if (!row.enabled || Number(row.domain_status_id) !== 1) {
    throw new Error(
      `ERP User "${username}" (${roleLabel}) is disabled or inactive in application_user.`
    );
  }
  if (row.account_locked) {
    throw new Error(`ERP User "${username}" (${roleLabel}) account is locked.`);
  }
  if (row.account_expired || row.password_expired) {
    throw new Error(`ERP User "${username}" (${roleLabel}) account or password is expired.`);
  }

  return {
    userId: Number(row.id),
    dbUsername: row.username,
    fullName: row.full_name,
    designation: row.designation_name || null
  };
}

/**
 * Validates both Branch (`branch.username` / `branch.password`) and Head Office
 * (`head.office.username` / `head.office.password`) credentials live against
 * BRAC ERP Keycloak OIDC and `application_user` on every run.
 * Throws immediately if either credential is invalid.
 */
async function validateAllCredentials(client, appConfig) {
  const baseUrl = appConfig.erp.baseUrl;
  const branchCred = appConfig.credentials.branch;
  const hoCred = appConfig.credentials.headOffice;

  // 1. Validate live against Keycloak OIDC in parallel
  const [branchAuth, hoAuth] = await Promise.all([
    authenticateAgainstErpKeycloak(
      baseUrl,
      branchCred.username,
      branchCred.password,
      'Branch Office (branch.username / branch.password)'
    ),
    authenticateAgainstErpKeycloak(
      baseUrl,
      hoCred.username,
      hoCred.password,
      'Head Office (head.office.username / head.office.password)'
    )
  ]);

  // 2. Verify active ERP user records sequentially on the pg Client
  const branchUserMeta = await verifyErpUserRecord(
    client,
    branchCred.username,
    'Branch Office'
  );
  const hoUserMeta = await verifyErpUserRecord(
    client,
    hoCred.username,
    'Head Office'
  );

  return {
    branch: {
      ...branchAuth,
      ...branchUserMeta
    },
    headOffice: {
      ...hoAuth,
      ...hoUserMeta
    },
    validatedAt: new Date().toISOString()
  };
}

module.exports = {
  validateAllCredentials,
  authenticateAgainstErpKeycloak,
  verifyErpUserRecord
};
