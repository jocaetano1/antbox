import { ActionService } from "/application/action_service.ts";
import { builtinAspects } from "./builtin_aspects/index.ts";
import { AggregationFormulaError } from "/domain/nodes/aggregation_formula_error.ts";
import { NodeFactory } from "/domain/nodes/node_factory.ts";
import { NodeFilterResult } from "/domain/nodes/node_repository.ts";

import { FileNode, FolderNode, Node } from "/domain/nodes/node.ts";

import {
  Aggregation,
  SmartFolderNode,
} from "/domain/nodes/smart_folder_node.ts";

import { FolderNotFoundError } from "/domain/nodes/folder_not_found_error.ts";
import { SmartFolderNodeNotFoundError } from "/domain/nodes/smart_folder_node_not_found_error.ts";
import { NodeNotFoundError } from "/domain/nodes/node_not_found_error.ts";

import { NodeFilter } from "/domain/nodes/node_filter.ts";
import { Either, left, right } from "/shared/either.ts";
import { NodeDeleter } from "/application/node_deleter.ts";
import {
  AggregationResult,
  Reducers,
  SmartFolderNodeEvaluation,
} from "./smart_folder_evaluation.ts";
import { NodeServiceContext } from "./node_service_context.ts";
import { ValidationError } from "../domain/nodes/validation_error.ts";
import { builtinActions } from "./builtin_actions/index.ts";
import { AspectService } from "./aspect_service.ts";
import { Action } from "../domain/actions/action.ts";
import { Aspect } from "../domain/aspects/aspect.ts";
import { AntboxError } from "../shared/antbox_error.ts";

export class NodeService {
  constructor(private readonly context: NodeServiceContext) {}

  get uuidGenerator() {
    return this.context.uuidGenerator;
  }

  get fidGenerator() {
    return this.context.fidGenerator;
  }

  get storage() {
    return this.context.storage;
  }

  get repository() {
    return this.context.repository;
  }

  async createFile(
    file: File,
    metadata: Partial<Node>
  ): Promise<Either<AntboxError, Node>> {
    metadata.title = metadata.title ?? file.name;

    const validOrErr = await this.verifyTitleAndParent(metadata);
    if (validOrErr.isLeft()) {
      return left(validOrErr.value);
    }

    let node: FileNode | SmartFolderNode | undefined;
    if (file.type === "application/json") {
      node = await this.tryToCreateSmartfolder(file, metadata);
    }

    if (!node) {
      node = this.createFileMetadata(metadata, file.type, file.size);
    }

    const validationErrors = await node.validate(() => Promise.resolve([]));

    if (validationErrors) {
      return left(validationErrors);
    }

    if (!node.isSmartFolder()) {
      await this.context.storage.write(node.uuid, file);
    }

    await this.context.repository.add(node);

    return right(node);
  }

  private async verifyTitleAndParent(
    metadata: Partial<Node>
  ): Promise<Either<AntboxError, void>> {
    if (!metadata.title) {
      return left(ValidationError.fromMsgs("title"));
    }

    const parent = metadata.parent ?? Node.ROOT_FOLDER_UUID;
    const folderExists = await this.getFolderIfExistsInRepo(parent);

    if (!folderExists) {
      return left(new FolderNotFoundError(parent));
    }

    return right(undefined);
  }

  private async tryToCreateSmartfolder(
    file: File,
    metadata: Partial<Node>
  ): Promise<SmartFolderNode | undefined> {
    try {
      const content = new TextDecoder().decode(await file.arrayBuffer());
      const json = JSON.parse(content);

      if (json.mimetype !== Node.SMART_FOLDER_MIMETYPE) {
        return undefined;
      }

      return NodeFactory.composeSmartFolder(
        {
          uuid: this.context.uuidGenerator!.generate(),
          fid: this.context.fidGenerator!.generate(metadata.title!),
          size: 0,
        },
        NodeFactory.extractMetadataFields(metadata),
        {
          filters: json.filters,
          aggregations: json.aggregations,
          title: json.title,
        }
      );
    } catch (_e) {
      return undefined;
    }
  }

  async createFolder(
    metadata: Partial<FolderNode>
  ): Promise<Either<AntboxError, FolderNode>> {
    const validOrErr = await this.verifyTitleAndParent(metadata);
    if (validOrErr.isLeft()) {
      return left(validOrErr.value);
    }

    const node = NodeFactory.createFolderMetadata(
      metadata.uuid ?? this.context.uuidGenerator.generate(),
      metadata.fid ?? this.context.fidGenerator.generate(metadata.title!),
      metadata
    );

    const validationErrors = await node.validate(() => Promise.resolve([]));

    if (validationErrors) {
      return left(validationErrors);
    }

    await this.context.repository.add(node);

    return right(node);
  }

  async createMetanode(
    metadata: Partial<Node>
  ): Promise<Either<AntboxError, Node>> {
    const validOrErr = await this.verifyTitleAndParent(metadata);
    if (validOrErr.isLeft()) {
      return left(validOrErr.value);
    }

    const node = this.createFileMetadata(
      metadata,
      metadata.mimetype ?? Node.META_NODE_MIMETYPE,
      0
    );

    const validationErrors = await node.validate(() => Promise.resolve([]));
    if (validationErrors) {
      return left(validationErrors);
    }

    await this.context.repository.add(node);

    return right(node);
  }

  async duplicate(uuid: string): Promise<Either<NodeNotFoundError, Node>> {
    const node = await this.get(uuid);

    if (node.isLeft()) {
      return left(node.value);
    }

    return this.copy(uuid, node.value.parent);
  }

  async copy(
    uuid: string,
    parent: string
  ): Promise<Either<NodeNotFoundError, Node>> {
    const node = await this.get(uuid);
    const file = await this.context.storage.read(uuid);

    if (node.isLeft()) {
      return left(node.value);
    }

    const newNode = this.createFileMetadata(
      { ...node.value, parent },
      node.value.mimetype,
      node.value.size
    );

    await this.context.storage.write(newNode.uuid, file);
    await this.context.repository.add(newNode);

    return right(newNode);
  }

  async updateFile(
    uuid: string,
    file: File
  ): Promise<Either<NodeNotFoundError, void>> {
    const nodeOrErr = await this.get(uuid);

    if (nodeOrErr.isLeft()) {
      return left(nodeOrErr.value);
    }

    nodeOrErr.value.modifiedTime = this.now();
    nodeOrErr.value.size = file.size;
    nodeOrErr.value.mimetype = file.type;

    await this.context.storage.write(uuid, file);

    await this.context.repository.update(nodeOrErr.value);

    return right(undefined);
  }

  async delete(uuid: string): Promise<Either<NodeNotFoundError, void>> {
    const nodeOrError = await this.get(uuid);

    if (nodeOrError.isLeft()) {
      return left(nodeOrError.value);
    }

    await NodeDeleter.for(nodeOrError.value, this.context).delete();

    return right(undefined);
  }

  async get(uuid: string): Promise<Either<NodeNotFoundError, Node>> {
    const builtinActionOrErr = await this.getBuiltinAction(uuid);
    if (builtinActionOrErr.isRight()) {
      return right(builtinActionOrErr.value);
    }

    const builtinAspectOrErr = await this.getBuiltinAspect(uuid);
    if (builtinAspectOrErr.isRight()) {
      return right(builtinAspectOrErr.value);
    }

    return this.getFromRepository(uuid);
  }

  private createFileMetadata(
    metadata: Partial<Node>,
    mimetype: string,
    size: number
  ) {
    const uuid = metadata.uuid ?? this.context.uuidGenerator.generate();
    const fid = metadata.fid ?? this.context.fidGenerator.generate(uuid);

    return NodeFactory.createFileMetadata(uuid, fid, metadata, mimetype, size);
  }

  private getBuiltinAction(
    uuid: string
  ): Promise<Either<NodeNotFoundError, Node>> {
    const action = builtinActions.find((a) => a.uuid === uuid);

    if (!action) {
      return Promise.resolve(left(new NodeNotFoundError(uuid)));
    }

    return Promise.resolve(right(this.builtinActionToNode(action)));
  }

  private getBuiltinAspect(
    uuid: string
  ): Promise<Either<NodeNotFoundError, Node>> {
    const aspect = builtinAspects.find((a) => a.uuid === uuid);

    if (!aspect) {
      return Promise.resolve(left(new NodeNotFoundError(uuid)));
    }

    return Promise.resolve(right(this.builtinAspectToNode(aspect)));
  }

  private getFromRepository(
    uuid: string
  ): Promise<Either<NodeNotFoundError, Node>> {
    if (Node.isFid(uuid)) {
      return this.context.repository.getByFid(Node.uuidToFid(uuid));
    }
    return this.context.repository.getById(uuid);
  }

  async list(
    parent = Node.ROOT_FOLDER_UUID
  ): Promise<Either<FolderNotFoundError, Node[]>> {
    const folderOrUndefined = await this.getFolderIfExistsInRepo(parent);
    if (folderOrUndefined.isLeft()) {
      return left(new FolderNotFoundError(parent));
    }

    const nodes = await this.context.repository
      .filter(
        [["parent", "==", folderOrUndefined.value.uuid]],
        Number.MAX_VALUE,
        1
      )
      .then((result) => result.nodes);

    if (parent === ActionService.ACTIONS_FOLDER_UUID) {
      return right(this.listActions(nodes));
    }

    if (parent === AspectService.ASPECTS_FOLDER_UUID) {
      return right(this.listAspects(nodes));
    }

    return right(nodes);
  }

  private listActions(nodes: Node[]): Node[] {
    const actions = builtinActions.map((a) => this.builtinActionToNode(a));

    return [...nodes, ...actions];
  }

  private builtinActionToNode(action: Action): Node {
    return {
      uuid: action.uuid,
      fid: action.uuid,
      title: action.title,

      mimetype: "application/javascript",
      size: 0,
      parent: ActionService.ACTIONS_FOLDER_UUID,

      createdTime: this.now(),
      modifiedTime: this.now(),
    } as Node;
  }

  private listAspects(nodes: Node[]): Node[] {
    const aspects = builtinAspects.map((a) => this.builtinAspectToNode(a));

    return [...nodes, ...aspects];
  }

  private builtinAspectToNode(aspect: Aspect): Node {
    return {
      uuid: aspect.uuid,
      fid: aspect.uuid,
      title: aspect.title,
      mimetype: "application/json",
      size: 0,
      parent: AspectService.ASPECTS_FOLDER_UUID,

      createdTime: this.now(),
      modifiedTime: this.now(),
    } as Node;
  }

  getFolderIfExistsInRepo(uuid: string): Promise<Either<void, FolderNode>> {
    if (Node.isRootFolder(uuid)) {
      return Promise.resolve(right(Node.rootFolder()));
    }

    return this.get(uuid).then((result) => {
      if (result.isRight() && result.value.isFolder()) {
        return right(result.value);
      }

      return left(undefined);
    });
  }

  query(
    filters: NodeFilter[],
    pageSize: number,
    pageToken: number
  ): Promise<Either<AntboxError, NodeFilterResult>> {
    return this.context.repository
      .filter(filters, pageSize, pageToken)
      .then((v) => right(v));
  }

  async update(
    uuid: string,
    data: Partial<Node>,
    merge = false
  ): Promise<Either<NodeNotFoundError, void>> {
    const nodeOrErr = await this.get(uuid);

    if (nodeOrErr.isLeft()) {
      return left(nodeOrErr.value);
    }

    const newNode = merge
      ? this.merge(nodeOrErr.value, data)
      : Object.assign(nodeOrErr.value, data);

    return this.context.repository.update(newNode);
  }

  private merge<T>(dst: T, src: Partial<T>): T {
    const proto = Object.getPrototypeOf(dst);
    const result = Object.assign(Object.create(proto), dst);

    for (const key in src) {
      if (!src[key] && src[key] !== 0 && src[key] !== false) {
        delete result[key];
        continue;
      }

      if (typeof src[key] === "object") {
        // deno-lint-ignore no-explicit-any
        result[key] = this.merge(result[key] ?? {}, src[key] as any);
        continue;
      }

      result[key] = src[key];
    }

    return result;
  }

  async evaluate(
    uuid: string
  ): Promise<
    Either<
      SmartFolderNodeNotFoundError | AggregationFormulaError,
      SmartFolderNodeEvaluation
    >
  > {
    const nodeOrErr = await this.context.repository.getById(uuid);

    if (nodeOrErr.isLeft()) {
      return left(new SmartFolderNodeNotFoundError(uuid));
    }

    if (!nodeOrErr.value.isSmartFolder()) {
      return left(new SmartFolderNodeNotFoundError(uuid));
    }

    const node = nodeOrErr.value;

    const evaluation = await this.context.repository
      .filter(node.filters, Number.MAX_VALUE, 1)
      .then((filtered) => ({ records: filtered.nodes }));

    if (node.hasAggregations()) {
      return this.appendAggregations(evaluation, node.aggregations!);
    }

    return right(evaluation);
  }

  private appendAggregations(
    evaluation: SmartFolderNodeEvaluation,
    aggregations: Aggregation[]
  ): Either<AggregationFormulaError, SmartFolderNodeEvaluation> {
    const aggregationsMap = aggregations.map((aggregation) => {
      const formula = Reducers[aggregation.formula as string];

      if (!formula) {
        left(new AggregationFormulaError(aggregation.formula));
      }

      return right({
        title: aggregation.title,
        value: formula(evaluation.records as Node[], aggregation.fieldName),
      });
    });

    const err = aggregationsMap.find((aggregation) => aggregation.isLeft());

    if (err) {
      return left(err.value as AggregationFormulaError);
    }

    return right({
      ...evaluation,
      aggregations: aggregationsMap.map(
        (aggregation) => aggregation.value as AggregationResult
      ),
    });
  }

  async export(uuid: string): Promise<Either<NodeNotFoundError, File>> {
    const builtinActionOrErr = await this.exportBuiltinAction(uuid);
    if (builtinActionOrErr.isRight()) {
      return builtinActionOrErr;
    }

    const builtinAspectOrErr = await this.exportBuiltinAspect(uuid);
    if (builtinAspectOrErr.isRight()) {
      return builtinAspectOrErr;
    }

    const nodeOrErr = await this.get(uuid);

    if (nodeOrErr.isLeft()) {
      return left(nodeOrErr.value);
    }

    if (nodeOrErr.value.isSmartFolder()) {
      return right(this.exportSmartfolder(nodeOrErr.value));
    }

    const file = await this.context.storage.read(uuid);

    return right(file);
  }

  private exportBuiltinAction(
    uuid: string
  ): Promise<Either<NodeNotFoundError, File>> {
    const action = builtinActions.find((action) => action.uuid === uuid);

    if (!action) {
      return Promise.resolve(left(new NodeNotFoundError(uuid)));
    }

    return ActionService.actionToFile(action).then((file) => right(file));
  }

  private exportBuiltinAspect(
    uuid: string
  ): Promise<Either<NodeNotFoundError, File>> {
    const aspect = builtinAspects.find((aspect) => aspect.uuid === uuid);

    if (!aspect) {
      return Promise.resolve(left(new NodeNotFoundError(uuid)));
    }

    return AspectService.aspectToFile(aspect).then((file) => right(file));
  }

  private exportSmartfolder(node: Node): File {
    const jsonText = JSON.stringify(node);

    return new File([jsonText], node.title.concat(".json"), {
      type: "application/json",
    });
  }

  private now() {
    return new Date().toISOString();
  }
}
