12. **Console API hardening** (issue #37, not in the handoff). Once linked, `GET /console/state` without a session
    returns `home_assistant.server`, `.user` and `.discovered` empty (and `session.user` empty): anyone on the LAN can
    call it. Before linking they stay filled, the link page and setup wizard show "Found <server>". Cookie-authenticated
    writes (anything but GET/HEAD) need `Origin: http://<Host>` or, without Origin, a Referer on that origin; else
    403 `cross-origin request refused`. Bearer-token writes are not checked. The handoff relied on SameSite=Lax alone.
