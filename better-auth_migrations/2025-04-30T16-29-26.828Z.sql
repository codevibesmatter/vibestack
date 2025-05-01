alter table "users" add column "email_verified" boolean not null;

create table "sessions" ("id" text not null primary key, "expires_at" timestamp not null, "token" text not null unique, "created_at" timestamp not null, "updated_at" timestamp not null, "ip_address" text, "user_agent" text, "user_id" text not null references "users" ("id"));

create table "accounts" ("id" text not null primary key, "account_id" text not null, "provider_id" text not null, "user_id" text not null references "users" ("id"), "access_token" text, "refresh_token" text, "id_token" text, "access_token_expires_at" timestamp, "scope" text, "password" text, "created_at" timestamp not null, "updated_at" timestamp not null);

create table "verifications" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expires_at" timestamp not null, "created_at" timestamp, "updated_at" timestamp);