15. **One sign-in, own account (#22).** The handoff (`ARCHITECTURE.md`, `HaLink.dc.html`, `Main.dc.html`) recommends
    linking with a separate non-admin HA user and refuses a console session to non-admins. Now the link page tells
    you to sign in with your own account, says in two sentences what the stored key can do, and keeps the separate
    user as an "Advanced" route. A non-admin HA user gets a view-only session (read scope; writes, tokens, unlink,
    factory reset → 403 "Home Assistant admin required") with a banner and a "Sign in as an admin" button, instead
    of a redirect back to the sign-in page. `ConsoleState.session.admin` tells the console which.
