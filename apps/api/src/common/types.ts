export interface UserPrincipal {
  kind: "user";
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}
