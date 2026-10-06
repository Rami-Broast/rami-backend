# `realtime/`

WebSocket push (socket.io) so the admin app's New Orders tray beeps the
instant an order lands, and customer/driver screens advance without polling.

## Shape

Two providers, deliberately split:

- **`RealtimeService`** — the domain facade. **No injected dependencies**: it
  holds an optional socket.io `Server` that the gateway hands it on init. Any
  feature module (and any integration test composing one) depends on this,
  never on the gateway, so pushing an event never drags in the transport or
  its auth machinery. When no server is registered (a test that never starts
  the transport), every emit is a silent no-op. Lives in `RealtimeModule`.
- **`RealtimeGateway`** — the transport. Owns the auth dependencies
  (`TokenService`, `ActorService`) and, on `afterInit`, registers its server
  into `RealtimeService`. Lives in `RealtimeGatewayModule`, wired once at the
  app root. Feature modules never import it.

## Guarantees

- **Handshake auth mirrors HTTP.** A socket must present a valid access token
  (handshake `auth.token` or `Authorization: Bearer`), the actor is resolved
  from the database (so a revoked account cannot hold a live socket), and the
  socket joins only the rooms its scope allows. Unauthorised sockets are
  disconnected immediately — never left half-open.
- **Rooms match branch isolation.** Owners join `staff:all`; branch staff
  join `branch:<id>` per assignment; customers join `customer:<id>`. A
  staff-facing event emits to `[branch:<id>, staff:all]`, so it reaches
  exactly that branch's staff plus every owner, de-duped by socket.io.
- **Push only, never a write path.** There are no `@SubscribeMessage`
  handlers that mutate state. Every change still goes through the REST choke
  points; realtime is a notification layer on top.
- **Best-effort, post-commit.** Emits are fire-and-forget and swallow their
  own failure, exactly like the notifications dispatcher — a push can never
  break the order/payment flow that triggered it. Producers call the service
  only after the relevant transaction has committed.

## Events (`REALTIME_EVENTS`)

| Event | Fired by | Audience |
| --- | --- | --- |
| `order.awaiting` | order placed into AWAITING_ACCEPTANCE | branch staff + owners |
| `order.transitioned` | any order status change | branch staff + owners, and the customer who placed it |
| `delivery.assigned` | a driver is assigned | branch staff + owners |
| `driver.location` | driver location ping during an active delivery | staff of that delivery's branch |

Clients connect to path `/realtime` with the access token in the handshake
auth, then listen for these events. `cors.origin` reflects because auth rides
in the token, not a cookie.
