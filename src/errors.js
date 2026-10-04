// Exit codes. An agent decides what to do next from the code alone, so each one
// names a situation, not a cause.
export const EXIT = Object.freeze({
  OK: 0,
  REFUSED: 1,          // Riffkit answered 4xx (except 401): the request was refused
  USAGE: 2,            // the command line cannot be sent as it is
  NOT_CONFIRMED: 3,    // a spend was not confirmed: nothing was sent
  SIGNED_OUT: 4,       // 401: run riffkit login
  NO_ANSWER_READ: 5,   // a read got no answer (network, 5xx): safe to run again
  NO_ANSWER_WRITE: 6,  // a write or spend got no answer: it may have been accepted
  WAIT_TIMEOUT: 10,    // riffkit wait reached --timeout
  NO_VIDEO: 11,        // riffkit wait: the batch finished, and some task in it made no video
  LOGIN_PENDING: 12,   // riffkit login with no terminal: the link is not approved yet; run login again once it is
})

/** A failure the user is told about in one line on stderr. The message never
 *  holds a session token. */
export class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export const usage = (message) => new CliError(EXIT.USAGE, message)
