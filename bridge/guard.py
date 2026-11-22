"""SSRF network guard for the Studio Bridge (TAD §7 / PRD R7).

All agent-initiated server-side fetches must pass `assert_public_http_url`:
- scheme restricted to http/https
- hostname required and resolved
- every resolved IP must be globally routable (refuses localhost, loopback,
  private RFC1918, link-local (incl. 169.254.169.254), CGNAT, multicast,
  reserved, and IPv4-mapped IPv6 trickery)
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

_ALLOWED_SCHEMES = ("http", "https")


def _is_routable(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    if isinstance(addr, ipaddress.IPv6Address):
        # Teredo/6to4 can encapsulate v4 privates; be conservative.
        if addr.teredo is not None or addr.sixtofour is not None:
            v4 = addr.teredo.client if addr.teredo else addr.sixtofour
            return _is_routable(str(v4))
    return addr.is_global and not addr.is_loopback and not addr.is_link_local and not addr.is_multicast


def resolved_ips(hostname: str) -> list[str]:
    infos = socket.getaddrinfo(hostname, None)
    ips: list[str] = []
    for _family, _type, _proto, _canonname, sockaddr in infos:
        ip = sockaddr[0]
        if ip not in ips:
            ips.append(ip)
    if not ips:
        raise ValueError(f"host did not resolve: {hostname!r}")
    return ips


def assert_public_http_url(url: str) -> list[str]:
    """Validate `url` for an agent-initiated fetch. Returns resolved IPs."""
    if not isinstance(url, str) or not url.strip():
        raise ValueError("url is required")
    parsed = urlparse(url.strip())
    if parsed.scheme not in _ALLOWED_SCHEMES:
        raise ValueError(f"scheme not allowed: {parsed.scheme!r} (use http/https)")
    host = parsed.hostname
    if not host:
        raise ValueError("url has no hostname")
    if host.lower() in ("localhost", "localhost.localdomain") or host.endswith(".local"):
        raise ValueError(f"host not allowed: {host!r}")
    # Literal IPs (incl. IPv6 in brackets) are handled by getaddrinfo too.
    for ip in resolved_ips(host):
        if not _is_routable(ip):
            raise ValueError(f"host {host!r} resolves to a non-routable address ({ip}); refused")
    return resolved_ips(host)


MAX_REDIRECTS = 5


def guarded_request(method: str, url: str, *, headers: dict | None = None, timeout: tuple | float = 30, stream: bool = False, max_bytes: int | None = None):
    """requests.get/head with per-hop SSRF validation (no auto-redirects).

    Every redirect target is itself validated (scheme + resolved IPs) before
    following. DNS-rebinding TOCTOU remains a documented M5 hardening item.
    """
    import requests

    session = requests.Session()
    current = url
    for hop in range(MAX_REDIRECTS + 1):
        assert_public_http_url(current)
        resp = session.request(
            method,
            current,
            headers={**({"User-Agent": "VendoTubeStudio/2.0 (research agent)"} or {}), **(headers or {})},
            timeout=timeout,
            stream=stream,
            allow_redirects=False,
        )
        if resp.is_redirect or resp.is_permanent_redirect:
            location = resp.headers.get("location", "")
            if not location:
                raise ValueError("redirect without a location header")
            from urllib.parse import urljoin

            current = urljoin(current, location)
            resp.close()
            continue
        return resp
    raise ValueError(f"too many redirects (> {MAX_REDIRECTS})")
