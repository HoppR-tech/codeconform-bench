# Grace guidance — OhMyForm clean architecture

Apply ports and adapters to the requested slice without changing observable behavior.

- Domain and application code must not import infrastructure, framework, transport, ORM, or UI modules.
- Define each port in the domain/application side in business terms. A port expresses an intention, not a vendor API.
- Implement ports only in infrastructure adapters. Keep TypeORM, NestJS, GraphQL, HTTP, mail, and persistence details there.
- Presentation/transport code may call application use cases; it must not contain domain decisions or reach repositories directly.
- Wire concrete adapters at the composition root. Do not instantiate infrastructure from domain/application code.
- Keep the cutover complete: migrate every caller in the selected slice and remove the superseded path rather than adding a compatibility shim.
- Preserve current behavior and run the available functional gate before finishing.
