import serverDataSource from "../datasources/server.js";

async function test() {
  await serverDataSource.initialize();
  
  // Update with new client_id
  const result = await serverDataSource.query(
    "UPDATE users SET name = $1, client_id = uuid_generate_v4() WHERE id = (SELECT id FROM users LIMIT 1) RETURNING *",
    ["Test User With New Client"]
  );
  console.log("1. Updated with new client_id:", result);

  // Update same record without changing client_id
  const followup = await serverDataSource.query(
    "UPDATE users SET name = $1 WHERE id = $2 RETURNING *",
    ["Another Update", result[0][0].id]
  );
  console.log("2. Updated without client_id (should be NULL):", followup);

  await serverDataSource.destroy();
}

test().catch(console.error); 