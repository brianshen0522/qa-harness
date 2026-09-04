# End-to-end tests

These suites boot the real Nest application, talk to a dedicated Postgres
database (`qa_harness_test`), and — where Docker is available — start real
sandbox containers.

`forceExit` is on. The API deliberately owns work that outlives a request:
the LLM health prober runs on a timer for the life of the process, and a
generation run keeps going after the client disconnects (that is the feature
being tested). Those are unref'd, but Node's global fetch pool and the
listening sockets some suites need keep the worker alive after the assertions
finish. Every suite still tears down its own app, containers and servers in
`afterAll`; `forceExit` only stops the worker lingering afterwards.
