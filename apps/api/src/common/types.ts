export interface UserPrincipal {
  kind: "user";
  id: string;
  email: string;
  name: string;
}
export interface AdminPrincipal {
  kind: "admin";
  id: string;
  email: string;
}
