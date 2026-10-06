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
 * Not just whether - WHY, and in words the page can print.
 *
 * `isSameHost` returning a bare false is what made this button feel broken: the
 * POST answered 403 with a sentence, the page threw the modal away and fired a
 * 2.6-second toast at it, and the one permanent line next to the button never
 * said anything. The verdict is now carried on the health poll the page already
 * makes, so the page can explain it BEFORE the button is pressed.
 *
 * @param {{socket?: {remoteAddress?: string, localAddress?: string}}} req
 * @param {NodeJS.ProcessEnv} env  read for the override rather than captured,
 *   so a test can pass its own.
 * @returns {{allowed: boolean, because: string}}
 */
export function shutdownPermission(req, env = process.env) {
  if (env.MOBILE_CFY_ALLOW_REMOTE_SHUTDOWN === '1') {
    return { allowed: true, because: 'MOBILE_CFY_ALLOW_REMOTE_SHUTDOWN=1 allows any device' };
  }
  const remote = req?.socket?.remoteAddress ?? '';
  const local = req?.socket?.localAddress ?? '';
  // No socket information at all (a test double, a proxied request): do not
  // lock somebody out of stopping their own server over a missing detail.
  if (!remote) return { allowed: true, because: 'the caller could not be identified' };
  // Either the browser used 127.0.0.1, or the phone answered on its own LAN
  // address - in both cases the peer is this machine.
  if (remote === local) return { allowed: true, because: `this is the phone itself (${remote})` };
  if (LOOPBACK.test(remote)) return { allowed: true, because: `this is the phone itself (${remote})` };
  return { allowed: false, because: `this page was opened from ${remote}, which is another device` };
}

/**
 * @param {{socket?: {remoteAddress?: string, localAddress?: string}}} req
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function isSameHost(req, env = process.env) {
  return shutdownPermission(req, env).allowed;
}