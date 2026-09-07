/**
 * Liveness of this process and nothing else. No database, no session, no API
 * — a dependency in here would report the deployment's health under the name
 * of this application's.
 */
export function GET() {
  return Response.json({ status: 'ok' });
}
