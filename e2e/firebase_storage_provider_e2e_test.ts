import { startServer } from "../mod.ts";

// const firebaseConfig = {
//     apiKey: "AIzaSyA35H9gdAgo85RtgJ89ISAAZfoalE0iVMQ",
//     authDomain: "pessoal-407411.firebaseapp.com",
//     projectId: "pessoal-407411",
//     storageBucket: "pessoal-407411.appspot.com",
//     messagingSenderId: "1019035304478",
//     appId: "1:1019035304478:web:5d758ce1c56cdd3575640f",
//     measurementId: "G-30V9CJW3WC"
// };

startServer({
	tenants: [
		{
			name: "firebase",
			storage: [
				"firebase/firebase_storage_provider.ts",
				"AIzaSyA35H9gdAgo85RtgJ89ISAAZfoalE0iVM",
				"pessoal-407411",
				"pessoal-407411.appspot.com",
				"1019035304478",
				"1:1019035304478:web:5d758ce1c56cdd3575640f",
				"G-30V9CJW3WC",
			],
			repository: [
				"flat_file/flat_file_node_repository.ts",
				"/tmp/repository/",
			],
		},
	],
});
