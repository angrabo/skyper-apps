/**
 * The Skyper activity SDK — the page half of the bridge whose client half is
 * `skyper.client/src/lib/activityHost.ts` and `ActivityFrame.tsx`.
 *
 * An activity is an ordinary web page mounted in a sandboxed iframe by the Skyper client. This file
 * is loaded like any script (same origin as the page — the copy-paste era is over):
 *
 *     <script src="/sdk/skyper-activity.js"></script>
 *     <script>
 *         const skyper = await SkyperActivity.connect();
 *         skyper.on('message', (senderId, payload) => { ... });
 *         skyper.send({ move: 4 });                    // relayed to everyone, sender stamped
 *         if (skyper.instance.isHost) skyper.setState({ board });   // the snapshot
 *     </script>
 *
 * The trust model, in one paragraph: the relay is the only channel between participants, every
 * message crosses the Skyper server, and the server stamps the sender's user id — so `senderId` on
 * an incoming message is trustworthy and nothing else about identity ever needs checking. The page
 * holds no credential and cannot reach Skyper's API; everything it may do, it does through here.
 *
 * Limits, enforced by the client and the server (mirroring the server's ActivityRules): a relay
 * payload is ≤ 16 KB of JSON at ~30 messages/second, and the snapshot — host-only — is ≤ 64 KB.
 * A send that breaks a limit is silently dropped; design payloads as deltas, and the snapshot as
 * the whole state.
 */
(function (global) {
    'use strict';

    function connect() {
        return new Promise(function (resolve) {
            var hostOrigin = null;
            var listeners = { message: [], session: [], layout: [] };
            var api = null;

            function post(message) {
                // Before init, `skyper:ready` goes to '*': it carries nothing, and the page cannot
                // yet know which origin mounted it. Everything after init is addressed to the
                // origin the init actually came from.
                global.parent.postMessage(message, hostOrigin || '*');
            }

            function emit(name, args) {
                for (var i = 0; i < listeners[name].length; i++) {
                    try { listeners[name][i].apply(null, args); } catch (error) { console.error(error); }
                }
            }

            global.addEventListener('message', function (event) {
                if (event.source !== global.parent) return;
                if (hostOrigin && event.origin !== hostOrigin) return;

                var data = event.data;
                if (!data || typeof data !== 'object') return;

                switch (data.type) {
                    case 'skyper:init':
                        if (api) return; // one init; a repeat is noise

                        hostOrigin = event.origin;

                        api = {
                            /** Who is here: sessionId, viewerId, hostId, controllerIds, isHost,
                             * people [{id, name}]. Replaced whole on every 'session' event. */
                            instance: data.session,

                            /** The snapshot as of mount — the board to boot from, or null for a
                             * fresh game. Late joiners and reloads start here, then follow the
                             * relay. */
                            state: typeof data.state === 'string' ? JSON.parse(data.state) : null,

                            /** 'docked' | 'floating' | 'fullscreen'. */
                            layout: data.layout,

                            /** on('message', (senderId, payload) => {}) — a relay message, sender
                             * stamped by the server (own sends echo back too);
                             * on('session', (instance) => {}) — people or roles changed;
                             * on('layout', (layout) => {}) — the window mode changed. */
                            on: function (name, fn) {
                                if (listeners[name]) listeners[name].push(fn);
                                return api;
                            },

                            /** Relay `payload` (any JSON value) to every participant. */
                            send: function (payload) {
                                post({ type: 'skyper:send', payload: payload });
                            },

                            /** Write the snapshot (host only — silently refused otherwise). */
                            setState: function (state) {
                                post({ type: 'skyper:state', state: state });
                            },

                            /** Ask the client to close: the host's page ends the session for
                             * everyone; anyone else's merely puts their own window away. */
                            requestClose: function () {
                                post({ type: 'skyper:close' });
                            }
                        };

                        resolve(api);
                        return;

                    case 'skyper:message':
                        if (!api) return;

                        var payload;
                        try { payload = JSON.parse(data.payload); } catch (error) { return; }

                        emit('message', [data.senderId, payload]);
                        return;

                    case 'skyper:session':
                        if (!api) return;

                        api.instance = data.session;
                        emit('session', [data.session]);
                        return;

                    case 'skyper:layout':
                        if (!api) return;

                        api.layout = data.layout;
                        emit('layout', [data.layout]);
                        return;
                }
            });

            // Told last, so the init that answers it cannot race the listener above.
            post({ type: 'skyper:ready' });
        });
    }

    global.SkyperActivity = { connect: connect };
})(window);
