import { z } from "zod";

export const ProfileField = z.object({ key: z.string().min(1), label: z.string(), value: z.string() });
export type ProfileField = z.infer<typeof ProfileField>;

export const Profile = z.object({ id: z.string().min(1), name: z.string(), fields: z.array(ProfileField) });
export type Profile = z.infer<typeof Profile>;
