# GeoIP session location

New sessions resolve canonical `ipAddress` against a local MaxMind GeoLite2
City MMDB. No authentication request calls a remote geolocation service.
`country` is an upper-case ISO alpha-2 code when available and `city` is a
bounded label; both are nullable and server-only.

Invalid, loopback, private, missing, and unmatched IPs return null fields.
Missing/corrupt MMDB and reader exceptions log a request-data-free warning and
fail open, so location can never block authentication.

The `geoipupdate` container writes `geoip_data`; backend mounts it read-only.
`GEOIPUPDATE_ACCOUNT_ID` and `GEOIPUPDATE_LICENSE_KEY` exist only in the VPS
runtime file. Operational setup: [`ops/geoip-session-location.md`](../ops/geoip-session-location.md).
