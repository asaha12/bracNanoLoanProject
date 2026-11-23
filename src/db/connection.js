const { Client, Pool } = require('pg');
const { loadAppConfig } = require('../config/appConfig');

function getDbConfig(appConfig) {
  const cfg = appConfig || loadAppConfig();
  return {
    user: cfg.db.user,
    password: cfg.db.password,
    host: cfg.db.host,
    database: cfg.db.database,
    port: cfg.db.port,
    connectionTimeoutMillis: cfg.db.connectionTimeoutMillis
  };
}

function getClient(appConfig) {
  return new Client(getDbConfig(appConfig));
}

function getPool(appConfig) {
  return new Pool(getDbConfig(appConfig));
}

module.exports = { getDbConfig, getClient, getPool };
