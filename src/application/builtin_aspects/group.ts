import { AuthService } from "../auth_service.ts";
import { Aspect } from "/domain/aspects/aspect.ts";

export const GroupAspect = {
  uuid: "group",
  title: "Grupo",
  builtIn: true,
  description: "Representa um grupo",
  filters: [
    ["mimetype", "==", "application/vnd.antbox.metanode"],
    ["parent", "==", [AuthService.GROUPS_FOLDER_UUID]],
  ],
} as Aspect;