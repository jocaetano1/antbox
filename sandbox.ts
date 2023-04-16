import { VERSION } from "./version.ts";

import { Command, IParseResult } from "/deps/command";

import {
	AntboxService,
	DefaultFidGenerator,
	DefaultUuidGenerator,
	InMemoryNodeRepository,
	InMemoryStorageProvider,
	ServerOpts,
	setupOakServer,
} from "./mod.ts";

const ROOT_PASSWD = "demo";

const program = await new Command()
	.name("sandbox")
	.version(VERSION)
	.description("Prova de conceito em memória")
	.option("--port <port>", "porta do servidor [7180]")
	.option("--passwd <passwd>", "senha do root [demo]")
	.parse(Deno.args);

function main(program: IParseResult) {
	const passwd = program.options.passwd || ROOT_PASSWD;

	const service = new AntboxService({
		uuidGenerator: new DefaultUuidGenerator(),
		fidGenerator: new DefaultFidGenerator(),
		repository: new InMemoryNodeRepository(),
		storage: new InMemoryStorageProvider(),
	});

	const serverOpts: ServerOpts = {};
	if (program.options.port) {
		serverOpts.port = parseInt(program.options.port);
	}

	const startServer = setupOakServer(service, passwd);

	startServer(serverOpts).then(() => {
		console.log(
			"Antbox Server started successfully on port ::",
			program.options.port ?? "7180",
		);
	});
}

main(program);
