const sqlSelectAuthCarriersForAccountAndSP = `
SELECT * FROM voip_carriers
WHERE trunk_type = 'auth'
AND is_active = 1
AND (
  (account_sid = ?)
  OR
  (service_provider_sid = ? AND account_sid IS NULL)
)`;

/**
 * Retrieves voip_carriers with trunk_type 'auth' that belong to either:
 * 1. The specified account (account_sid matches), OR
 * 2. The service provider but with null account_sid (shared across the service provider)
 *
 * @param {*} pool - mysql connection pool
 * @param {*} logger
 * @param {string} account_sid - the sid of the account
 * @param {string} service_provider_sid - the sid of the service provider
 * @returns {Promise<Array>} array of voip_carrier records matching the criteria
 */
async function lookupAuthCarriersForAccountAndSP(pool, logger, account_sid, service_provider_sid) {
  const pp = pool.promise();
  try {
    const [rows] = await pp.query(sqlSelectAuthCarriersForAccountAndSP, [account_sid, service_provider_sid]);
    return rows;
  } catch (err) {
    logger.error({err, account_sid, service_provider_sid}, 'lookupAuthCarriersForAccountAndSP');
    throw err;
  }
}

module.exports = {
  lookupAuthCarriersForAccountAndSP
};
