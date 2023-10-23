import { AuthContextProvider } from "../domain/auth/auth_provider.ts";
import { Group } from "../domain/auth/group.ts";
import { GroupCreatedEvent } from "../domain/auth/group_created_event.ts";
import { GroupDeletedEvent } from "../domain/auth/group_deleted_event.ts";
import { GroupUpdatedEvent } from "../domain/auth/group_updated_event%20.ts";
import { User } from "../domain/auth/user.ts";
import { UserCreatedEvent } from "../domain/auth/user_created_event.ts";
import { UserDeletedEvent } from "../domain/auth/user_deleted_event.ts";
import { UserUpdatedEvent } from "../domain/auth/user_updated_event.ts";
import { AggregationFormulaError } from "../domain/nodes/aggregation_formula_error.ts";
import { ApiKeyNode } from "../domain/nodes/api_key_node.ts";
import { FolderNode } from "../domain/nodes/folder_node.ts";
import { Node, Permission } from "../domain/nodes/node.ts";
import { NodeContentUpdatedEvent } from "../domain/nodes/node_content_updated_event.ts";
import { NodeCreatedEvent } from "../domain/nodes/node_created_event.ts";
import { NodeDeletedEvent } from "../domain/nodes/node_deleted_event.ts";
import { NodeFilter } from "../domain/nodes/node_filter.ts";
import { NodeNotFoundError } from "../domain/nodes/node_not_found_error.ts";
import { NodeFilterResult } from "../domain/nodes/node_repository.ts";
import { NodeUpdatedEvent } from "../domain/nodes/node_updated_event.ts";
import { SmartFolderNodeEvaluation } from "../domain/nodes/smart_folder_evaluation.ts";
import { SmartFolderNodeNotFoundError } from "../domain/nodes/smart_folder_node_not_found_error.ts";
import { AntboxError, BadRequestError, ForbiddenError } from "../shared/antbox_error.ts";
import { Either, left, right } from "../shared/either.ts";
import { ActionService } from "./action_service.ts";
import { ApiKeyService } from "./api_keys_service.ts";
import { AspectService } from "./aspect_service.ts";
import { AuthService } from "./auth_service.ts";
import { DomainEvents } from "./domain_events.ts";
import { ExtService } from "./ext_service.ts";
import { NodeService } from "./node_service.ts";
import { NodeServiceContext } from "./node_service_context.ts";

import { ActionNode } from "../domain/actions/action_node.ts";
import { AspectNode } from "../domain/aspects/aspect_node.ts";
import { builtinActions } from "./builtin_actions/mod.ts";

export class AntboxService {
	readonly nodeService: NodeService;
	readonly authService: AuthService;
	readonly aspectService: AspectService;
	readonly actionService: ActionService;
	readonly extService: ExtService;
	readonly apiKeysService: ApiKeyService;

	constructor(nodeCtx: NodeServiceContext) {
		this.nodeService = new NodeService(nodeCtx);
		this.authService = new AuthService(this.nodeService);
		this.aspectService = new AspectService(this.nodeService);
		this.actionService = new ActionService(this.nodeService, this);
		this.apiKeysService = new ApiKeyService(this.nodeService, nodeCtx.uuidGenerator);

		this.extService = new ExtService(this.nodeService);

		this.subscribeToDomainEvents();
		nodeCtx.storage.startListeners((eventId, handler) => {
			DomainEvents.subscribe(eventId, handler);
		});
	}

	async createFile(
		authCtx: AuthContextProvider,
		file: File,
		metadata: Partial<Node>,
	): Promise<Either<AntboxError, Node>> {
		const parent = metadata.parent ?? Node.ROOT_FOLDER_UUID;
		if (FolderNode.isSystemFolder(parent)) {
			return left(new BadRequestError("Cannot create regular files in system folder"));
		}

		if (Node.isRootFolder(parent)) {
			return left(new ForbiddenError());
		}

		const parentOrErr = await this.#getFolderWithPermission(
			authCtx,
			parent,
			"Write",
		);

		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		const nodeOrErr = await this.nodeService.createFile(file, {
			...metadata,
			owner: authCtx.principal.email!,
			parent: parentOrErr.value.uuid,
		});
		if (nodeOrErr.isRight()) {
			DomainEvents.notify(
				new NodeCreatedEvent(authCtx.principal.email!, nodeOrErr.value),
			);
		}

		return nodeOrErr;
	}

	async create(
		authCtx: AuthContextProvider,
		metadata: Partial<Node | FolderNode>,
	): Promise<Either<AntboxError, Node>> {
		if (FolderNode.isSystemFolder(metadata.parent!)) {
			return left(new BadRequestError("Cannot regular nodes in system folder"));
		}

		if (FolderNode.isRootFolder(metadata.parent!) && !Node.isFolder(metadata)) {
			return left(new BadRequestError("Cannot create regular files in root folder"));
		}

		const parentOrErr = await this.#getFolderWithPermission(
			authCtx,
			metadata.parent ?? Node.ROOT_FOLDER_UUID,
			"Write",
		);

		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		if (Node.isFolder(metadata)) {
			return this.#createFolder(authCtx, metadata, parentOrErr.value);
		}

		return this.nodeService.create({
			...metadata,
			parent: parentOrErr.value.uuid,
			owner: authCtx.principal.email!,
		})
			.then((result) => {
				if (result.isRight()) {
					DomainEvents.notify(
						new NodeCreatedEvent(authCtx.principal.email!, result.value),
					);
				}

				return result;
			});
	}

	async #createFolder(
		authCtx: AuthContextProvider,
		metadata: Partial<FolderNode>,
		parent: FolderNode,
	): Promise<Either<AntboxError, FolderNode>> {
		const result = await this.nodeService.create({
			...metadata,
			parent: parent.uuid,
			owner: authCtx.principal.email!,
			group: authCtx.principal.group,
			permissions: metadata.permissions ?? {
				...parent.permissions,
			},
		} as Partial<FolderNode>);

		if (result.isRight()) {
			DomainEvents.notify(new NodeCreatedEvent(authCtx.principal.email!, result.value));
		}

		return right(result.value as FolderNode);
	}

	async list(
		authCtx: AuthContextProvider,
		uuid = Node.ROOT_FOLDER_UUID,
	): Promise<Either<AntboxError, Node[]>> {
		if (FolderNode.isSystemFolder(uuid)) {
			return left(new NodeNotFoundError(uuid));
		}

		if (FolderNode.isSystemRootFolder(uuid) && !User.isAdmin(authCtx.principal)) {
			return left(new ForbiddenError());
		}

		const parentOrErr = await this.#getFolderWithPermission(authCtx, uuid, "Read");
		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		const listOrErr = await this.nodeService.list(uuid);
		if (listOrErr.isLeft()) {
			return left(listOrErr.value);
		}

		const nodes = listOrErr.value.filter(
			(n) => !n.isFolder() || this.#assertCanRead(authCtx, n).isRight(),
		);

		return right(nodes);
	}

	async #getFolderWithPermission(
		auth: AuthContextProvider,
		uuid = Node.ROOT_FOLDER_UUID,
		permission: Permission,
	): Promise<Either<AntboxError, FolderNode>> {
		const folderOrErr = await this.nodeService.get(uuid);
		if (folderOrErr.isLeft()) {
			return left(folderOrErr.value);
		}

		if (!folderOrErr.value.isFolder()) {
			return left(new BadRequestError("Is not a folder"));
		}

		const voidOrErr = this.#assertPermission(auth, folderOrErr.value, permission);
		if (voidOrErr.isLeft()) {
			return left(voidOrErr.value);
		}

		return right(folderOrErr.value);
	}

	#assertCanRead(
		authCtx: AuthContextProvider,
		folder: FolderNode,
	): Either<AntboxError, void> {
		return this.#assertPermission(authCtx, folder, "Read");
	}

	#assertCanWrite(
		authCtx: AuthContextProvider,
		parent: FolderNode,
	): Either<AntboxError, void> {
		return this.#assertPermission(authCtx, parent, "Write");
	}

	#assertPermission(
		authCtx: AuthContextProvider,
		node: Node,
		permission: Permission,
	): Either<AntboxError, void> {
		const principal = authCtx.principal;

		if (!node.isFolder()) {
			return right(undefined);
		}

		if (User.isAdmin(principal)) {
			return right(undefined);
		}

		if (node.isRootFolder() && permission === "Read") {
			return right(undefined);
		}

		if (node.isRootFolder() && !User.isAdmin(principal)) {
			return left(new ForbiddenError());
		}

		if (node.owner === authCtx.principal.email!) {
			return right(undefined);
		}

		if (node.permissions.anonymous.includes(permission)) {
			return right(undefined);
		}

		if (
			principal.groups.includes(node.group) &&
			node.permissions.group.includes(permission)
		) {
			return right(undefined);
		}

		if (
			principal.email! !== User.ANONYMOUS_USER_EMAIL &&
			node.permissions.authenticated.includes(permission)
		) {
			return right(undefined);
		}

		return left(new ForbiddenError());
	}

	async get(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<NodeNotFoundError, Node>> {
		if (FolderNode.isSystemFolder(uuid) && !User.isAdmin(authCtx.principal)) {
			return left(new ForbiddenError());
		}

		if (FolderNode.isSystemFolder(uuid)) {
			return right(FolderNode.SYSTEM_FOLDERS.find((folder) => folder.uuid === uuid)!);
		}

		const nodeOrErr = await this.nodeService.get(uuid);
		if (nodeOrErr.isLeft()) {
			return left(nodeOrErr.value);
		}

		if (FolderNode.isSystemFolder(nodeOrErr.value.parent!)) {
			return left(new NodeNotFoundError(uuid));
		}

		if (nodeOrErr.value.isFolder()) {
			return this.#getFolder(authCtx, nodeOrErr.value);
		}

		const parentOrErr = await this.#getFolderWithPermission(
			authCtx,
			nodeOrErr.value.parent,
			"Read",
		);
		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		return right(nodeOrErr.value);
	}

	#getFolder(authCtx: AuthContextProvider, folder: FolderNode): Either<AntboxError, FolderNode> {
		const assertNodeOrErr = this.#assertCanRead(authCtx, folder);
		if (assertNodeOrErr.isLeft()) {
			return left(assertNodeOrErr.value);
		}

		return right(folder);
	}

	query(
		_authCtx: AuthContextProvider,
		filters: NodeFilter[],
		pageSize = 25,
		pageToken = 1,
	): Promise<Either<AntboxError, NodeFilterResult>> {
		const noSystemNodes = this.#removeSystemNodesUnlessRequested(filters);
		return this.nodeService.query(noSystemNodes, pageSize, pageToken);
	}

	#removeSystemNodesUnlessRequested(filters: NodeFilter[]): NodeFilter[] {
		let systemNodes = [...Node.SYSTEM_MIMETYPES];

		const withMimetype = filters.filter(([field, _operator, _value]) => field === "mimetype");

		withMimetype.forEach(([_, operator, value]) => {
			if (operator === "==") {
				systemNodes = systemNodes.filter((mimetype) => mimetype !== value);
			}

			if (operator === "in") {
				systemNodes = systemNodes.filter((v) => !(value as string[]).includes(v));
			}
		});

		return [...filters, ["mimetype", "not-in", systemNodes]];
	}

	async update(
		authCtx: AuthContextProvider,
		uuid: string,
		metadata: Partial<Node>,
		merge?: boolean,
	): Promise<Either<AntboxError, void>> {
		const nodeOrErr = await this.get(authCtx, uuid);
		if (nodeOrErr.isLeft()) {
			return left(nodeOrErr.value);
		}

		const node = nodeOrErr.value;
		const parentOrErr = await this.#getFolderWithPermission(authCtx, node.parent, "Write");
		if (parentOrErr.isLeft()) {
			return left(new ForbiddenError());
		}

		if (node.isAspect()) {
			return this.#updateAspect(authCtx, uuid, metadata);
		}

		const diffs = this.#getDiffs(node, metadata);

		if (node.isFolder()) {
			return this.updateFolder(
				authCtx,
				node,
				diffs as Partial<FolderNode>,
			);
		}

		if (diffs.parent) {
			const newParentOrErr = await this.#getFolderWithPermission(
				authCtx,
				metadata.parent,
				"Write",
			);
			if (newParentOrErr.isLeft()) {
				return left(new ForbiddenError());
			}
		}

		const voidOrErr = await this.nodeService.update(uuid, diffs, merge);
		if (voidOrErr.isRight()) {
			DomainEvents.notify(
				new NodeUpdatedEvent(authCtx.principal.email!, uuid, diffs),
			);
		}

		return voidOrErr;
	}

	#updateAspect(
		authCtx: AuthContextProvider,
		uuid: string,
		metadata: Partial<Node>,
	): Either<AntboxError, void> | PromiseLike<Either<AntboxError, void>> {
		return this.aspectService.createOrReplace({ uuid, ...metadata }).then((result) => {
			if (result.isLeft()) {
				return left(result.value);
			}

			DomainEvents.notify(new NodeUpdatedEvent(authCtx.principal.email!, uuid, metadata));

			return right(undefined);
		});
	}

	#getDiffs(node: Node, metadata: Partial<Node>): Partial<Node> {
		const diffs: Record<string, unknown> = {};

		const n = node as unknown as Record<string, unknown>;
		const m = metadata as Record<string, unknown>;

		for (const key in metadata) {
			if (n[key] !== m[key]) {
				diffs[key] = m[key];
			}
		}

		if (metadata.properties) {
			diffs.properties = {
				...node.properties,
				...metadata.properties,
			};
		}

		return diffs;
	}

	async updateFolder(
		authCtx: AuthContextProvider,
		folder: FolderNode,
		metadata: Partial<FolderNode>,
	): Promise<Either<AntboxError, void>> {
		const assertNodeOrErr = this.#assertCanWrite(authCtx, folder);
		if (assertNodeOrErr.isLeft()) {
			return left(assertNodeOrErr.value);
		}

		if (metadata.parent) {
			const newParentOrErr = await this.#getFolderWithPermission(
				authCtx,
				metadata.parent,
				"Write",
			);
			if (newParentOrErr.isLeft()) {
				return left(new ForbiddenError());
			}
		}

		const voidOrErr = await this.nodeService.update(folder.uuid, metadata);
		if (voidOrErr.isRight()) {
			DomainEvents.notify(
				new NodeUpdatedEvent(folder.owner, folder.uuid, metadata),
			);
		}

		return voidOrErr;
	}

	async export(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<NodeNotFoundError | ForbiddenError, File>> {
		const nodeOrErr = await this.get(authCtx, uuid);
		if (nodeOrErr.isLeft()) {
			return left(nodeOrErr.value);
		}

		if (FolderNode.isSystemFolder(nodeOrErr.value.parent!)) {
			return left(new NodeNotFoundError(uuid));
		}

		const parentOrErr = await this.#getFolderWithPermission(
			authCtx,
			nodeOrErr.value.parent,
			"Export",
		);
		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		return this.nodeService.export(nodeOrErr.value.uuid);
	}

	async copy(
		authCtx: AuthContextProvider,
		uuid: string,
		parent: string,
	): Promise<Either<AntboxError, Node>> {
		const noderOrErr = await this.get(authCtx, uuid);
		if (noderOrErr.isLeft()) {
			return left(noderOrErr.value);
		}

		const parentOrErr = await this.#getFolderWithPermission(authCtx, parent, "Write");
		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		const voidOrErr = await this.nodeService.copy(uuid, parent);
		if (voidOrErr.isRight()) {
			DomainEvents.notify(
				new NodeCreatedEvent(authCtx.principal.email!, voidOrErr.value),
			);
		}

		return voidOrErr;
	}

	async duplicate(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<AntboxError, Node>> {
		const noderOrErr = await this.get(authCtx, uuid);
		if (noderOrErr.isLeft()) {
			return left(noderOrErr.value);
		}

		const parentOrErr = await this.#getFolderWithPermission(
			authCtx,
			noderOrErr.value.parent,
			"Write",
		);
		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		return this.nodeService.duplicate(uuid);
	}

	async updateFile(
		authCtx: AuthContextProvider,
		uuid: string,
		file: File,
	): Promise<Either<AntboxError, void>> {
		const nodeOrErr = await this.get(authCtx, uuid);
		if (nodeOrErr.isLeft()) {
			return Promise.resolve(left(nodeOrErr.value));
		}

		if (FolderNode.isSystemFolder(nodeOrErr.value.parent!)) {
			return left(new NodeNotFoundError(uuid));
		}

		const result = await this.nodeService.updateFile(uuid, file);
		if (result.isRight()) {
			DomainEvents.notify(
				new NodeContentUpdatedEvent(authCtx.principal.email!, uuid),
			);
		}

		return result;
	}

	async evaluate(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<
		Either<
			SmartFolderNodeNotFoundError | AggregationFormulaError,
			SmartFolderNodeEvaluation
		>
	> {
		const nodeOrErr = await this.get(authCtx, uuid);
		if (nodeOrErr.isLeft()) {
			return left(nodeOrErr.value);
		}

		return this.nodeService.evaluate(uuid);
	}

	async delete(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<AntboxError, void>> {
		const nodeOrErr = await this.get(authCtx, uuid);
		if (nodeOrErr.isLeft()) {
			return left(nodeOrErr.value);
		}

		if (nodeOrErr.value.isUser()) {
			return this.deleteUser(authCtx, uuid);
		}

		if (nodeOrErr.value.isGroup()) {
			return this.deleteGroup(authCtx, uuid);
		}

		if (nodeOrErr.value.isFolder() && this.#assertCanWrite(authCtx, nodeOrErr.value).isLeft()) {
			return left(new ForbiddenError());
		}

		const parentOrErr = await this.#getFolderWithPermission(
			authCtx,
			nodeOrErr.value.parent,
			"Write",
		);
		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		const voidOrErr = await this.nodeService.delete(uuid);
		if (voidOrErr.isRight()) {
			DomainEvents.notify(new NodeDeletedEvent(authCtx.principal.email!, nodeOrErr.value));
		}

		return voidOrErr;
	}

	/**** ACTION ****/

	createOrReplaceAction(authCtx: AuthContextProvider, action: File) {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.actionService.createOrReplace(action);
	}

	deleteAction(authCtx: AuthContextProvider, uuid: string) {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.actionService.delete(uuid);
	}

	getAction(
		_authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<AntboxError, ActionNode>> {
		return this.actionService.get(uuid);
	}

	exportAction(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<AntboxError, File>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.actionService.export(uuid);
	}

	runAction(
		authCtx: AuthContextProvider,
		uuid: string,
		uuids: string[],
		params: Record<string, string>,
	) {
		return this.actionService.run(authCtx, uuid, uuids, params);
	}

	listActions(_authCtx: AuthContextProvider): Promise<Either<AntboxError, ActionNode[]>> {
		return this.actionService.list().then((nodesOrErr) => {
			if (nodesOrErr.isLeft()) {
				return left(nodesOrErr.value);
			}

			return right(nodesOrErr.value);
		});
	}

	/**** ACTION ****/
	createOrReplaceExtension(authCtx: AuthContextProvider, file: File, metadata: Partial<Node>) {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.extService.createOrReplace(file, metadata);
	}

	updateExtension(authCtx: AuthContextProvider, uuid: string, metadata: Partial<Node>) {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.extService.update(uuid, metadata);
	}

	deleteExtension(authCtx: AuthContextProvider, uuid: string) {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.extService.delete(uuid);
	}

	getExtension(
		_authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<AntboxError, Node>> {
		return this.extService.get(uuid);
	}

	exportExtension(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<AntboxError, File>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.extService.export(uuid);
	}

	listExtensions(_authCtx: AuthContextProvider): Promise<Either<AntboxError, Node[]>> {
		return this.extService.list();
	}

	/**** ASPECTS  ****/
	getAspect(
		_authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<AntboxError, AspectNode>> {
		return this.aspectService.get(uuid);
	}

	listAspects(_authCtx: AuthContextProvider): Promise<Either<AntboxError, AspectNode[]>> {
		return this.aspectService.list().then((nodes) => right(nodes));
	}

	createOrReplaceAspect(authCtx: AuthContextProvider, aspect: Partial<AspectNode>) {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.aspectService.createOrReplace(aspect);
	}

	exportAspect(authCtx: AuthContextProvider, uuid: string): Promise<Either<AntboxError, File>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.aspectService.export(uuid);
	}

	deleteAspect(authCtx: AuthContextProvider, uuid: string) {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.aspectService.delete(uuid);
	}

	async createUser(authCtx: AuthContextProvider, user: User): Promise<Either<AntboxError, Node>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		const nodeOrErr = await this.authService.createUser({
			...user,
			owner: authCtx.principal.email!,
		});

		if (nodeOrErr.isRight()) {
			const evt = new UserCreatedEvent(
				authCtx.principal.email!,
				nodeOrErr.value.uuid,
				nodeOrErr.value.title,
			);

			DomainEvents.notify(evt);
		}

		return nodeOrErr;
	}

	listUsers(authCtx: AuthContextProvider): Promise<Either<AntboxError, User[]>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.authService.listUsers();
	}

	getUser(authCtx: AuthContextProvider, uuid: string): Promise<Either<AntboxError, User>> {
		if (!User.isAdmin(authCtx.principal) && authCtx.principal.uuid !== uuid) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.authService.getUser(uuid);
	}

	async updateUser(
		authCtx: AuthContextProvider,
		uuid: string,
		user: User,
	): Promise<Either<AntboxError, void>> {
		if (!User.isAdmin(authCtx.principal) && authCtx.principal.uuid !== uuid) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		const voidOrErr = await this.authService.updateUser(uuid, user);

		if (voidOrErr.isRight()) {
			const evt = new UserUpdatedEvent(
				authCtx.principal.email!,
				uuid,
				user.fullname!,
			);

			DomainEvents.notify(evt);
		}

		return voidOrErr;
	}

	async deleteUser(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<AntboxError, void>> {
		if (!User.isAdmin(authCtx.principal) && authCtx.principal.uuid !== uuid) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		const voidOrErr = await this.authService.deleteUser(uuid);

		if (voidOrErr.isRight()) {
			const evt = new UserDeletedEvent(authCtx.principal.email!, uuid);

			DomainEvents.notify(evt);
		}

		return voidOrErr;
	}

	listGroups(authCtx: AuthContextProvider): Promise<Either<AntboxError, Group[]>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.authService.listGroups();
	}

	getGroup(authCtx: AuthContextProvider, uuid: string): Promise<Either<AntboxError, Group>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.authService.getGroup(uuid);
	}

	async createGroup(
		authCtx: AuthContextProvider,
		group: Group,
	): Promise<Either<AntboxError, Node>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		const nodeOrErr = await this.authService.createGroup({
			...group,
			owner: authCtx.principal.email!,
		});

		if (nodeOrErr.isRight()) {
			const evt = new GroupCreatedEvent(
				authCtx.principal.email!,
				nodeOrErr.value.uuid,
				nodeOrErr.value.title,
			);

			DomainEvents.notify(evt);
		}

		return nodeOrErr;
	}

	async updateGroup(
		authCtx: AuthContextProvider,
		uuid: string,
		group: Group,
	): Promise<Either<AntboxError, void>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		const voidOrErr = await this.authService.updateGroup(uuid, group);

		if (voidOrErr.isRight()) {
			const evt = new GroupUpdatedEvent(
				authCtx.principal.email!,
				uuid,
				group.title,
			);

			DomainEvents.notify(evt);
		}

		return voidOrErr;
	}

	async deleteGroup(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<AntboxError, void>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		const voidOrErr = await this.authService.deleteGroup(uuid);

		if (voidOrErr.isRight()) {
			const evt = new GroupDeletedEvent(authCtx.principal.email!, uuid);

			DomainEvents.notify(evt);
		}

		return voidOrErr;
	}

	/**** API KEYS  ****/
	getApiKey(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<AntboxError, ApiKeyNode>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.apiKeysService.get(uuid);
	}

	listApiKeys(authCtx: AuthContextProvider): Promise<Either<AntboxError, ApiKeyNode[]>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.apiKeysService.list();
	}

	createApiKey(
		authCtx: AuthContextProvider,
		group: string,
	): Promise<Either<AntboxError, ApiKeyNode>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		if (!group) {
			return Promise.resolve(left(new BadRequestError("Group is required")));
		}

		return this.apiKeysService.create(group, authCtx.principal.email!);
	}

	deleteApiKey(authCtx: AuthContextProvider, uuid: string): Promise<Either<AntboxError, void>> {
		if (!User.isAdmin(authCtx.principal)) {
			return Promise.resolve(left(new ForbiddenError()));
		}

		return this.apiKeysService.delete(uuid);
	}

	runExtension(
		uuid: string,
		request: Request,
	): Promise<Either<Error, Response>> {
		return this.extService.run(uuid, request);
	}

	private subscribeToDomainEvents() {
		DomainEvents.subscribe(NodeCreatedEvent.EVENT_ID, {
			handle: (evt) => this.actionService.runOnCreateScritps(evt as NodeCreatedEvent),
		});
		DomainEvents.subscribe(NodeUpdatedEvent.EVENT_ID, {
			handle: (evt) => this.actionService.runOnUpdatedScritps(evt as NodeUpdatedEvent),
		});
		DomainEvents.subscribe(NodeCreatedEvent.EVENT_ID, {
			handle: (evt) =>
				this.actionService.runAutomaticActionsForCreates(
					evt as NodeCreatedEvent,
				),
		});
		DomainEvents.subscribe(NodeUpdatedEvent.EVENT_ID, {
			handle: (evt) =>
				this.actionService.runAutomaticActionsForUpdates(
					evt as NodeUpdatedEvent,
				),
		});
	}
}
