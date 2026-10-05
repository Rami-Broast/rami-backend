import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { ActorService } from '../auth/services/actor.service';
import { AppConfigService } from '../config/app-config.service';
import { TokenService } from '../auth/services/token.service';
import { Actor, isCustomer, isStaff } from '../auth/types/actor';
import { ROOMS, RealtimeService } from './realtime.service';

/**
 * The realtime transport (socket.io).
 *
 * Connections are authenticated on the handshake the same way HTTP requests
 * are: a valid access token is required, the actor is resolved from the
 * database (so a revoked account cannot hold a live socket), and the socket
 * joins exactly the rooms its scope allows. An unauthenticated or
 * unresolvable socket is disconnected immediately — a socket is never left
 * open in a "connected but not authorised" state.
 *
 * Emission is one-directional: the server pushes, clients only listen. There
 * are deliberately no `@SubscribeMessage` handlers that mutate anything —
 * every state change still goes through the REST choke points, and realtime
 * is a notification layer on top, never an alternative write path.
 *
 * The gateway owns the transport and the auth dependencies; `RealtimeService`
 * owns the domain emit API. On init the gateway hands its server to the
 * service, so feature modules depend only on the lightweight service and
 * never on this gateway (or on auth) — see realtime.service.ts.
 *
 * The socket CORS allow-list is the same one the HTTP API uses. It previously
 * reflected any origin, on the reasoning that auth rides in the handshake token
 * rather than a cookie, so there is no ambient-credential surface to protect —
 * which is true, and still not a reason for any page on the internet to be able
 * to open a socket and start guessing tokens. `credentials` stays off for the
 * original reason.
 *
 * An empty allow-list means no browser origin, which is correct for a
 * mobile-only deployment and is what the HTTP side already does.
 */
/**
 * The browser origins allowed to open a socket.
 *
 * Module-scoped because `@WebSocketGateway` is evaluated when this class is
 * defined — before dependency injection exists — so the decorator cannot read
 * `AppConfigService`. The gateway's constructor fills this in from the same
 * validated config the HTTP CORS layer uses, which happens long before any
 * connection arrives. No module reads `process.env` directly.
 */
let allowedOrigins: readonly string[] = [];

@WebSocketGateway({
  cors: {
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // A non-browser client sends no Origin at all. CORS does not apply to it
      // and refusing it here would break every mobile app.
      callback(null, !origin || allowedOrigins.includes(origin));
    },
    credentials: false,
  },
  path: '/realtime',
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly realtime: RealtimeService,
    private readonly tokens: TokenService,
    private readonly actors: ActorService,
    config: AppConfigService,
  ) {
    allowedOrigins = config.app.corsAllowedOrigins;
  }

  afterInit(server: Server): void {
    this.realtime.register(server);
    this.logger.log('Realtime gateway initialised on /realtime');
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) {
        this.reject(client, 'no token');
        return;
      }

      const payload = this.tokens.verifyAccessToken(token);
      const actor = await this.actors.resolve(payload.typ, payload.sub);

      this.joinRooms(client, actor);
      client.emit('connected', {
        kind: actor.kind,
        rooms: [...client.rooms].filter((r) => r !== client.id),
      });
    } catch {
      // Never leak why — same discipline as the HTTP auth guard.
      this.reject(client, 'auth failed');
    }
  }

  handleDisconnect(client: Socket): void {
    // socket.io leaves rooms automatically; nothing to clean up.
    this.logger.debug(`socket ${client.id} disconnected`);
  }

  private joinRooms(client: Socket, actor: Actor): void {
    if (isStaff(actor)) {
      // A driver is a staff actor with no branch scope at all, so the branch
      // logic below would leave their socket in no room and the app back on
      // its poll. `deliveries:own` is the DRIVER role's only permission and is
      // held by nobody else, which makes it the honest test for "this socket
      // belongs to someone who gets assigned jobs".
      if (actor.permissions.has('deliveries:own')) {
        void client.join(ROOMS.driver(actor.id));
      }

      const scope = actor.branchScope;
      if (scope.kind === 'ALL') {
        void client.join(ROOMS.staffAll);
      } else if (scope.kind === 'ASSIGNED') {
        for (const branchId of scope.branchIds) {
          void client.join(ROOMS.branch(branchId));
        }
      }
      return;
    }

    if (isCustomer(actor)) {
      void client.join(ROOMS.customer(actor.id));
    }
  }

  private extractToken(client: Socket): string | null {
    // Preferred: socket.io handshake auth. Fallback: Authorization header, so
    // a plain WebSocket client that cannot set handshake auth still works.
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    const authToken = auth?.token;
    if (typeof authToken === 'string' && authToken.length > 0) {
      return authToken;
    }
    const header = client.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length);
    }
    return null;
  }

  private reject(client: Socket, reason: string): void {
    this.logger.debug(`rejecting socket ${client.id}: ${reason}`);
    client.emit('unauthorized', { message: 'Authentication required.' });
    client.disconnect(true);
  }
}
