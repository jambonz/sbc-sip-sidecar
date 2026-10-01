/* Detect that this instance is being scaled in by polling IMDS autoscaling/target-lifecycle-state,
 * the same signal sbc-inbound drains on: it reads 'Terminated' once the Auto Scaling group moves
 * the instance to Terminating:Wait. Detection only -- sbc-inbound owns the lifecycle hook and
 * completes it once calls have drained, so this needs no Auto Scaling API access.
 *
 * IMDSv2 only: fetch a session token with PUT, then present it on the GET. */
const IMDS = 'http://169.254.169.254/latest';
const IMDS_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 20000;

const imds = async(path) => {
  const tokenRes = await fetch(`${IMDS}/api/token`, {
    method: 'PUT',
    headers: {'X-aws-ec2-metadata-token-ttl-seconds': '60'},
    signal: AbortSignal.timeout(IMDS_TIMEOUT_MS)
  });
  if (!tokenRes.ok) throw new Error(`IMDS token request failed: ${tokenRes.status}`);
  const token = await tokenRes.text();
  const res = await fetch(`${IMDS}/meta-data/${path}`, {
    headers: {'X-aws-ec2-metadata-token': token},
    signal: AbortSignal.timeout(IMDS_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`IMDS ${path} request failed: ${res.status}`);
  return res.text();
};

module.exports = (logger, onScaleIn, {interval = POLL_INTERVAL_MS} = {}) => {
  let fired = false;
  const timer = setInterval(async() => {
    try {
      const state = await imds('autoscaling/target-lifecycle-state');
      if (state !== 'Terminated' || fired) return;
      fired = true;
      clearInterval(timer);
      logger.info('AWS scale-in detected (target-lifecycle-state is Terminated)');
      onScaleIn();
    } catch (err) {
      logger.warn({err}, 'Error polling IMDS autoscaling/target-lifecycle-state');
    }
  }, interval);
  timer.unref();
  logger.info('AWS lifecycle drain enabled: polling IMDS autoscaling/target-lifecycle-state');
  return timer;
};
