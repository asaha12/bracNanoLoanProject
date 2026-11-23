/**
 * Dynamic Credit Score Band Evaluator
 * Matches computed metric values against live bands loaded from
 * credit_risk_model_conf_credit_score_band.
 */

function getBandsForParameter(allBands, parameterCode, projectId) {
  const projectSpecific = (allBands || []).filter(
    (b) => b.parameterCode === parameterCode && Number(b.projectInfoId) === Number(projectId)
  );
  if (projectSpecific.length > 0) {
    return projectSpecific.sort((a, b) => a.bandSeq - b.bandSeq);
  }

  return (allBands || [])
    .filter((b) => b.parameterCode === parameterCode && b.projectInfoId === null)
    .sort((a, b) => a.bandSeq - b.bandSeq);
}

/**
 * Matches a numeric percentage value against live DB score bands.
 */
function matchNumericBand(allBands, parameterCode, projectId, value, fallback) {
  const bands = getBandsForParameter(allBands, parameterCode, projectId);

  for (const band of bands) {
    const lowerOk =
      band.lowerBound === null ||
      (band.lowerInclusive ? value >= band.lowerBound : value > band.lowerBound);
    const upperOk =
      band.upperBound === null ||
      (band.upperInclusive ? value <= band.upperBound : value < band.upperBound);

    if (lowerOk && upperOk) {
      return {
        score: band.scoreValue,
        label: band.bandLabel,
        bandSeq: band.bandSeq
      };
    }
  }

  return fallback;
}

/**
 * Matches a discrete sequence band (used for Param 1 and Param 4 where bounds are null).
 */
function matchSeqBand(allBands, parameterCode, projectId, bandSeq, fallback) {
  const bands = getBandsForParameter(allBands, parameterCode, projectId);
  const found = bands.find((b) => b.bandSeq === bandSeq);
  if (found) {
    return {
      score: found.scoreValue,
      label: found.bandLabel,
      bandSeq: found.bandSeq
    };
  }
  return fallback;
}

/**
 * Resolves live parameter configuration (loan_count, days_before_repayment, etc.)
 * preferring project-specific row over project-agnostic (null) row.
 */
function getScoreParameterConfig(allParams, parameterCode, projectId) {
  const projectSpecific = (allParams || []).find(
    (p) => p.parameterCode === parameterCode && Number(p.projectInfoId) === Number(projectId)
  );
  if (projectSpecific) return projectSpecific;

  return (
    (allParams || []).find(
      (p) => p.parameterCode === parameterCode && p.projectInfoId === null
    ) || null
  );
}

module.exports = {
  getBandsForParameter,
  matchNumericBand,
  matchSeqBand,
  getScoreParameterConfig
};
