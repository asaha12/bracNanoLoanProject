const { Client, Pool } = require('pg');

const dbConfig = {
  user: 'aditya_2344',
  password: 'Th7T0fKG3$DYJ53E',
  host: '10.150.150.52',
  database: 'sbicloud_bd',
  port: 4550,
  connectionTimeoutMillis: 10000
};

function getClient() {
  return new Client(dbConfig);
}

function getPool() {
  return new Pool(dbConfig);
}

module.exports = { dbConfig, getClient, getPool };
