import { FolderNode } from "/domain/nodes/node.ts";
import { ROOT_FOLDER_UUID } from "/domain/nodes/node.ts";
import {
  AspectServiceForActions,
  NodeServiceForActions,
  Action,
} from "/domain/actions/action.ts";
import { ActionRepository } from "/domain/actions/action_repository.ts";
import { UserPrincipal } from "/domain/auth/user_principal.ts";

import { AuthService } from "./auth_service.ts";
import { builtinActions } from "./builtin_actions/index.js";
import { DomainEvents } from "./domain_events.ts";
import { NodeCreatedEvent } from "/domain/nodes/node_created_event.ts";
import { NodeUpdatedEvent } from "/domain/nodes/node_updated_event.ts";

export interface ActionServiceContext {
  readonly authService: AuthService;
  readonly nodeService: NodeServiceForActions;
  readonly aspectService: AspectServiceForActions;
  readonly repository: ActionRepository;
}

export class ActionService {
  private readonly context: ActionServiceContext;

  constructor(context: ActionServiceContext) {
    this.context = context;

    DomainEvents.subscribe<NodeCreatedEvent>(NodeCreatedEvent.EVENT_ID, {
      handle: (evt) => this.runOnCreateScritps(evt),
    });

    DomainEvents.subscribe<NodeUpdatedEvent>(NodeUpdatedEvent.EVENT_ID, {
      handle: (evt) => this.runOnUpdatedScritps(evt),
    });
  }

  async createOrReplace(_principal: UserPrincipal, file: File): Promise<void> {
    const action = await this.fileToAction(file);

    action.spec.builtIn = false;

    this.validateAction(action);

    return this.context.repository.addOrReplace({
      ...action,
      uuid: file.name.split(".")[0],
    });
  }

  private async fileToAction(file: File): Promise<Action> {
    const url = URL.createObjectURL(file);
    const mod = await import(url);

    return mod as Action;
  }

  private validateAction(_action: Action): void {}

  async delete(_principal: UserPrincipal, uuid: string): Promise<void> {
    await this.context.repository.delete(uuid);
  }

  get(_principal: UserPrincipal, uuid: string): Promise<Action> {
    return this.context.repository.get(uuid);
  }

  list(_principal: UserPrincipal): Promise<Action[]> {
    return this.context.repository
      .getAll()
      .then((actions) => [
        ...(builtinActions as unknown as Action[]),
        ...actions,
      ]);
  }

  async run(
    principal: UserPrincipal,
    uuid: string,
    uuids: string[],
    params: Record<string, string>
  ): Promise<void> {
    const action = await this.get(principal, uuid);

    if (!action) {
      throw new Error(`Action ${uuid} not found`);
    }

    const error = await action.run(
      { ...this.context, principal },
      uuids,
      params
    );

    if (error) {
      throw error;
    }
  }

  async runOnCreateScritps(evt: NodeCreatedEvent) {
    if (evt.payload.parent === ROOT_FOLDER_UUID) {
      return;
    }

    const parent = (await this.context.nodeService.get(
      this.context.authService.getSystemUser(),
      evt.payload.parent!
    )) as FolderNode;

    if (!parent) {
      return;
    }

    await this.runActions(parent.onCreate, evt.payload.uuid);
  }

  async runOnUpdatedScritps(evt: NodeUpdatedEvent) {
    const node = await this.context.nodeService.get(
      null as unknown as UserPrincipal,
      evt.payload.uuid
    );

    if (!node || node.parent === ROOT_FOLDER_UUID) {
      return;
    }

    const parent = (await this.context.nodeService.get(
      this.context.authService.getSystemUser(),
      node.parent!
    )) as FolderNode;

    if (!parent) {
      return;
    }

    await this.runActions(parent.onUpdate, evt.payload.uuid);
  }

  private async runActions(actions: string[], uuid: string) {
    for (const action of actions) {
      const [actionUuid, params] = action.split(" ");
      const j = `{${params ?? ""}}`;
      const g = j.replaceAll(/(\w+)=(\w+)/g, '"$1": "$2"');

      await this.run(
        this.context.authService.getSystemUser(),
        actionUuid,
        [uuid],
        JSON.parse(g)
      );
    }
  }
}
