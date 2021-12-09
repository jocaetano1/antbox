import { Aspect } from "./aspect.ts";
import { AspectRepository } from "./aspect_repository.ts";
import { AuthService } from "./auth_service.ts";
import { RequestContext } from "./request_context.ts";

export interface AspectServiceContext {
	readonly auth?: AuthService;
	readonly repository: AspectRepository;
}


export interface AspectService {
	/**
	 * Cria um novo aspecto.
	 */
	create(request: RequestContext, aspect: Aspect): Promise<void>;

	/**
	 * Apaga de forma permanente um aspecto.
	 */
	delete(request: RequestContext, uuid: string): Promise<void>;

	/**
	 * Devolve um aspecto.
	 */
	get(request: RequestContext, uuid: string): Promise<Aspect>;

	/**
	 * Lista todos os aspectos registados.
	 */
	list(request: RequestContext): Promise<Aspect[]>;

	/**
	 * Actualiza o conteúdo de um aspecto.
	 * @param uuid
	 * @param aspect
	 */
	update(
		request: RequestContext,
		uuid: string,
		aspect: Aspect,
	): Promise<void>;
}
