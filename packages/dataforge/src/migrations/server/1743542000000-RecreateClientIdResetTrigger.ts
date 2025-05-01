// This file was created automatically to resolve a build error.
// Please add the necessary migration logic if required.

import { MigrationInterface, QueryRunner } from 'typeorm';

export class RecreateClientIdResetTrigger1743542000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add migration logic here
    console.log('Applying migration: RecreateClientIdResetTrigger1743542000000');
    // Example: await queryRunner.query('CREATE TABLE example (id serial PRIMARY KEY);');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Add rollback logic here
    console.log('Reverting migration: RecreateClientIdResetTrigger1743542000000');
    // Example: await queryRunner.query('DROP TABLE example;');
  }
} 