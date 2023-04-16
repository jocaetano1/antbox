import { assertFalse, assertStrictEquals } from "/deps/asserts";
import { assertSpyCalls, spy } from "/deps/mock";

import { AuthService } from "./auth_service.ts";
import { DefaultUuidGenerator } from "/strategies/default_uuid_generator.ts";

import { DomainEvents } from "./domain_events.ts";
import { UserCreatedEvent } from "/domain/auth/user_created_event.ts";
import { GroupCreatedEvent } from "/domain/auth/group_created_event.ts";

import { User } from "../domain/auth/user.ts";
import { NodeService } from "./node_service.ts";
import { NodeServiceContext } from "./node_service_context.ts";
import { InMemoryNodeRepository } from "../adapters/inmem/inmem_node_repository.ts";
import { InMemoryStorageProvider } from "../adapters/inmem/inmem_storage_provider.ts";
import { DefaultFidGenerator } from "../adapters/strategies/default_fid_generator.ts";
import { InvalidGroupNameFormatError } from "../domain/auth/invalid_group_name_format_error.ts";
import { InvalidEmailFormatError } from "../domain/auth/invalid_email_format_error.ts";
import { AntboxError } from "../shared/antbox_error.ts";
import { InvalidFullnameFormatError } from "../domain/auth/invalid_fullname_format_error.ts";

const eventHandler = { handle: () => undefined };

Deno.test("createUser", async (t) => {
	await t.step("Grava o user no repositorio", async () => {
		const nodeService = makeNodeService();

		const createMetanodeSpy = spy(nodeService, "createMetanode");

		const svc = new AuthService(nodeService);

		await svc.createUser(User.create("user1@antbox.io", "Antbox User"));
		assertSpyCalls(createMetanodeSpy, 1);
	});

	await t.step("Deve lançar o evento UserCreatedEvent", async () => {
		const eventHandlerSpy = spy(eventHandler, "handle");

		DomainEvents.clearHandlers();
		DomainEvents.subscribe(UserCreatedEvent.EVENT_ID, eventHandler);

		const svc = new AuthService(makeNodeService());

		const result = await svc.createUser(
			User.create("user@domain.com", "Some User"),
		);

		assertFalse(result.isLeft());
		assertSpyCalls(eventHandlerSpy, 1);
	});

	await t.step(
		"Erro @InvalidEmailFormat se o formato do email for inválido",
		async () => {
			const svc = new AuthService(makeNodeService());
			const result = await svc.createUser(
				User.create("bademailformat", "Some User"),
			);

			assertStrictEquals(result.isLeft(), true);
			assertStrictEquals(
				(result.value as AntboxError).errorCode,
				InvalidEmailFormatError.ERROR_CODE,
			);
		},
	);

	await t.step(
		"Erro @InvalidFullnameFormat se o formato do nome for inválido",
		async () => {
			const svc = new AuthService(makeNodeService());
			const result = await svc.createUser(User.create("user@user.com", ""));

			assertFalse(result.isRight(), undefined);
			assertStrictEquals(
				(result.value as AntboxError).errorCode,
				InvalidFullnameFormatError.ERROR_CODE,
			);
		},
	);
});

Deno.test("createGroup", async (t) => {
	await t.step("Grava o grupo no repositorio", async () => {
		const nodeService = makeNodeService();
		const createMetanodeSpy = spy(nodeService, "createMetanode");

		const svc = new AuthService(nodeService);

		await svc.createGroup({ title: "Group1" });

		assertSpyCalls(createMetanodeSpy, 1);
	});

	await t.step(
		"Erro @InvalidGroupNameFormat se o formato do nome for inválido",
		async () => {
			const svc = new AuthService(makeNodeService());
			const result = await svc.createGroup({ title: "" });

			assertStrictEquals(result.isLeft(), true);
			assertStrictEquals(
				(result.value as InvalidGroupNameFormatError).errorCode,
				InvalidGroupNameFormatError.ERROR_CODE,
			);
		},
	);

	await t.step("Deve lançar o evento GroupCreatedEvent", async () => {
		DomainEvents.clearHandlers();
		DomainEvents.subscribe(GroupCreatedEvent.EVENT_ID, eventHandler);

		const eventHandlerSpy = spy(eventHandler, "handle");

		const svc = new AuthService(makeNodeService());

		const result = await svc.createGroup({ title: "Group1" });

		assertFalse(result.isLeft());
		assertSpyCalls(eventHandlerSpy, 1);
	});
});

function makeNodeService(): NodeService {
	const ctx: NodeServiceContext = {
		fidGenerator: new DefaultFidGenerator(),
		repository: new InMemoryNodeRepository(),
		storage: new InMemoryStorageProvider(),
		uuidGenerator: new DefaultUuidGenerator(),
	};

	const srv = new NodeService(ctx);

	return srv;
}
