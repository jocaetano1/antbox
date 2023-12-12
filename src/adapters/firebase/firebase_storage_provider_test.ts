import { StorageReference, FirebaseStorage, UploadResult } from 'npm:@firebase/storage'
import { assertEquals, assertSpyCalls, spy } from "../../../dev_deps.ts";
import { assertSpyCall } from "https://deno.land/std@0.183.0/testing/mock.ts?source.ts";
import { FirebaseStorageProvider, FirebaseGateway } from "./firebase_storage_provider.ts";

Deno.test('FirebaseStorageProvider', async (t) => {
    await t.step("Deve criar o ref do file", async () => {
        const gateway = makeFakeFirebaseStorage()
        const storage = new FirebaseStorageProvider(gateway)
        const refSpy = spy(gateway, "ref")
        const storageRef = makeStorageRef("some_uuid")
        await storage.delete("some_uuid")

        assertSpyCall(refSpy, 0, { args: [{} as FirebaseStorage, "some_uuid"], returned:  storageRef })
        assertSpyCalls(refSpy, 1)
    })

    await t.step("Deve apagar o file", async () => {
        const gateway = makeFakeFirebaseStorage()
        const provider = new FirebaseStorageProvider(gateway)
        const deleteObjectSpy = spy(gateway, "deleteObject")
        const fakeStorageRef = makeStorageRef("some_uuid") 

        await provider.delete("some_uuid")

        assertSpyCall(deleteObjectSpy, 0, { args: [fakeStorageRef], returned: Promise.resolve(undefined) })
        assertSpyCalls(deleteObjectSpy, 1)
    })
    
    await t.step("Deve retornar um erro caso o deleteObject falhe", async () => {
        const gateway = makeFakeFirebaseStorage()
        const provider = new FirebaseStorageProvider(gateway)
        const error = new Error()
        Object.assign(gateway, { deleteObject: () => Promise.reject(error) })

        const result = await provider.delete("some_uuid")

        assertEquals(result.isLeft(), true)        
    })

    await t.step("Deve cria a ref para escreve o file", async () => {
        const uuid = "some_uuid"
        const gateway = makeFakeFirebaseStorage()
        const provider = new FirebaseStorageProvider(gateway)
        const refSpy = spy(gateway, "ref")
        const file =  new File([""], uuid, { type: "text/plain" })

        await provider.write(uuid, file, options)

        assertSpyCall(refSpy, 0, { args: [{} as FirebaseStorage, uuid], returned: makeStorageRef(uuid) })
        assertSpyCalls(refSpy, 1)
    })

    await t.step("Deve fazer o upload do file", async () => {
        const uuid = "some_uuid"
        const gateway = makeFakeFirebaseStorage()
        const provider = new FirebaseStorageProvider(gateway)
        const uploadBytesSpy = spy(gateway, "uploadBytes")
        const file =  new File([""], uuid, { type: "text/plain" })
        const fakeStorageRef = makeStorageRef(uuid)
        const metadata = {
            contentType: file.type, 
            customMetadata: {}
        }

        await provider.write(uuid, file)

        assertSpyCall(uploadBytesSpy, 0, { args: [fakeStorageRef, file, metadata], returned: Promise.resolve({}) })
        assertSpyCalls(uploadBytesSpy, 1)
    })

    await t.step("Deve atribuir os metadados para o upload", async () => {
        const uuid = "some_uuid"
        const gateway = makeFakeFirebaseStorage()
        const provider = new FirebaseStorageProvider(gateway)
        const uploadBytesSpy = spy(gateway, "uploadBytes")
        const file =  new File([""], uuid, { type: "text/plain" })
        const fakeStorageRef = makeStorageRef(uuid)
        const metadata = {
            contentType: file.type,
            customMetadata: {
                title: options.title,
                parent: options.parent
            }
        }

        await provider.write(uuid, file, options)


        assertSpyCall(uploadBytesSpy, 0, { args: [fakeStorageRef, file, metadata], returned: Promise.resolve({}) })
        assertSpyCalls(uploadBytesSpy, 1)
    })

    await t.step("Deve retornar um erro caso o uploadBytes falhe", async () => {
        const uuid = "some_uuid"
        const gateway = makeFakeFirebaseStorage()
        const provider = new FirebaseStorageProvider(gateway)
        const error = new Error()
        Object.assign(gateway, { uploadBytes: () => Promise.reject(error) })
        const file =  new File([""], uuid, { type: "text/plain" })

        const result = await provider.write(uuid, file)

        assertEquals(result.isLeft(), true)
    })

    await t.step("Deve criar o ref para ler o file", async () => {
        const uuid = "some_uuid"
        const gateway = makeFakeFirebaseStorage()
        const provider = new FirebaseStorageProvider(gateway)
        const refSpy = spy(gateway, "ref")
        const fakeStorageRef = makeStorageRef(uuid)

        await provider.read(uuid)

        assertSpyCall(refSpy, 0, { args: [{} as FirebaseStorage, uuid], returned: fakeStorageRef })
        assertSpyCalls(refSpy, 1)
    })

    await t.step("Deve retornar o file", async () => {
        const uuid = "some_uuid"
        const gateway = makeFakeFirebaseStorage()
        const getDownloadUrlSpy = spy(gateway, "getDownloadURL")
        const provider = new FirebaseStorageProvider(gateway)
        const fakeStorageRef = makeStorageRef(uuid)

        await provider.read(uuid)

        assertSpyCall(getDownloadUrlSpy, 0, { args: [fakeStorageRef], returned: Promise.resolve('/s/o/some_uuid') })
        assertSpyCalls(getDownloadUrlSpy, 1)
    })

    await t.step("Deve retornar um erro caso o getDownloadURL falhe", async () => {
        const uuid = "some_uuid"
        const gateway = makeFakeFirebaseStorage()
        const provider = new FirebaseStorageProvider(gateway)
        const error = new Error()
        Object.assign(gateway, { getDownloadURL: () => Promise.reject(error) })

        const result = await provider.read(uuid)

        assertEquals(result.isLeft(), true)
    })
})


function makeFakeFirebaseStorage(): FirebaseGateway {
    return {
        storage: {} as FirebaseStorage,
        ref: (storage: FirebaseStorage, url: string) => {
            const [l1, l2] = url
            return {
                bucket: '', 
                fullPath: `${l1}/${l2}/${url}`, 
                name: '', 
                storage: storage,
                parent: null,
                root: {} as StorageReference
    
            } as StorageReference
        },
        deleteObject: (_ref: StorageReference) => Promise.resolve(undefined),
        uploadBytes: (_ref, _data, _metadata?) => Promise.resolve({} as UploadResult),
        getDownloadURL: (ref) => Promise.resolve(ref.fullPath),
    }
}


function makeStorageRef(url: string): StorageReference {
    const [l1, l2] = url
    return {
        bucket: '', 
        fullPath: `${l1}/${l2}/${url}`, 
        name: '', 
        storage: {} as FirebaseStorage,
        parent: null,
        root: {} as StorageReference
    }
}

const options = {
    title: "some_title",
    parent: "some_parent"
}