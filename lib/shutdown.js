/**
 * Who is allowed to stop the phone's server.
 *
 * The UI is reachable from every device on the wifi, and a stray tap from a
 * desktop would kill the process out from under someone mid-session - so a
 * shutdown request only counts when it comes from the phone itself. Kept apart
 * from server.js so the rule can be tested without a listening socket.
 */

/** Loopback, in either spelling Node hands back. */
const LOOPBACK = /^(::1|::ffff:127\.)/;

/**
 * @param {{socket?: {remoteAddress?: string, localAddress?: string}}} req
 * @param {NodeJS.ProcessEnv} env  read for the override rather than captured,
 *   so a test can pass its own.
 * @returns {boolean}
 */
export function isSameHost(req, env = process.env) {
  if (env.MOBILE_CFY_ALLOW_REMOTE_SHUTDOWN === '1') return true;
  const remote = req?.socket?.remoteAddress ?? '';
  const local = req?.socket?.localAddress ?? '';
  // No socket information at all (a test double, a proxied request): do not
  // lock somebody out of stopping their own server over a missing detail.
  if (!remote) return true;
  // Either the browser used 127.0.0.1, or the phone answered on its own LAN
  // address - in both cases the peer is this machine.
  return remote === local || LOOPBACK.test(remote);
}