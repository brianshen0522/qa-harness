import "dotenv/config";
// Point at the dedicated test database (same server, different db name).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL!.replace(/\/qa_harness(\?|$)/, "/qa_harness_test$1");
process.env.DEV_LOGIN_ENABLED = "true";
// e2e fetches localhost test servers; the SSRF guard would otherwise block them.
process.env.ALLOW_PRIVATE_FETCH = "true";
