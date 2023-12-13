import {
	deleteObject,
	FirebaseStorage,
	getDownloadURL,
	getStorage,
	ref,
	StorageReference,
	uploadBytes,
	UploadMetadata,
	UploadResult,
} from "npm:firebase/storage";

import { initializeApp } from "npm:firebase/app";
import { StorageProvider, WriteFileOpts } from "../../domain/providers/storage_provider.ts";
import { AntboxError, UnknownError } from "../../shared/antbox_error.ts";
import { Either, left, right } from "../../shared/either.ts";
import { Event } from "../../shared/event.ts";
import { EventHandler } from "../../shared/event_handler.ts";

export default function buildFirebaseStorageProvider(
	firebaseConfig: FirebaseConfig,
): Promise<Either<AntboxError, StorageProvider>> {
	const app = initializeApp(firebaseConfig);
	const storage = getStorage(app);
	const gateway: FirebaseGateway = {
		storage,
		ref: (storage, url) => {
			const [l1, l2] = url;
			return ref(storage, `${l1}/${l2}/${url}`);
		},
		deleteObject,
		uploadBytes,
		getDownloadURL,
	};

	return Promise.resolve(right(new FirebaseStorageProvider(gateway)));
}

export class FirebaseStorageProvider implements StorageProvider {
	readonly #gateway: FirebaseGateway;

	constructor(gateway: FirebaseGateway) {
		this.#gateway = gateway;
	}

	delete(uuid: string): Promise<Either<AntboxError, void>> {
		const fileRef = this.#gateway.ref(this.#gateway.storage, uuid);

		return this.#gateway.deleteObject(fileRef)
			.then(() => right<AntboxError, void>(undefined))
			.catch((e: Error) => left<AntboxError, void>(new UnknownError(e.message)));
	}

	write(
		uuid: string,
		file: File,
		opts?: WriteFileOpts | undefined,
	): Promise<Either<AntboxError, void>> {
		const fileRef = this.#gateway.ref(this.#gateway.storage, uuid);

		const metadata = {
			contentType: file.type,
			customMetadata: opts ? opts : {},
		};

		return this.#gateway.uploadBytes(fileRef, file, metadata)
			.then(() => {
				return right<AntboxError, void>(undefined);
			})
			.catch((e: Error) => {
				return left<AntboxError, void>(new UnknownError(e.message));
			});
	}

	read(uuid: string): Promise<Either<AntboxError, File>> {
		const fileRef = this.#gateway.ref(this.#gateway.storage, uuid);

		return this.#gateway.getDownloadURL(fileRef).then((url) => {
			return Deno.readFile(url)
				.then((fileContent) => new File([fileContent], uuid))
				.then((file) => right<AntboxError, File>(file))
				.catch((e: Error) => left<AntboxError, File>(new UnknownError(e.message)));
		}).catch((e: Error) => left<AntboxError, File>(new UnknownError(e.message)));
	}

	startListeners(_bus: (eventId: string, handler: EventHandler<Event>) => void): void {}
}

export interface FirebaseGateway {
	storage: FirebaseStorage;
	ref: (storage: FirebaseStorage, url: string) => StorageReference;
	deleteObject: (ref: StorageReference) => Promise<void>;
	uploadBytes: (
		ref: StorageReference,
		// deno-lint-ignore no-explicit-any
		data: any, // Blob | ArrayBuffer | Uint8Array | File
		metadata?: UploadMetadata,
	) => Promise<UploadResult>;
	getDownloadURL: (ref: StorageReference) => Promise<string>;
}

interface FirebaseConfig {
	apiKey: string;
	authDomain: string;
	projectId: string;
	storageBucket: string;
	messagingSenderId: string;
	appId: string;
	measurementId: string;
}
