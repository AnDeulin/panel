---
name: website-faq-assistant
description: Build or adapt a reusable website FAQ chat with approved answers and a visitor-controlled handoff to a person. Use for bounded product or service support, a free static assistant, or an optional model that selects FAQ cards. Open-ended business diagnostics use a separate conversational lead-magnet workflow.
---

# Website FAQ assistant

Give visitors an accurate answer and a clear next action. Keep the business facts and contacts in configuration so the same component can serve another site.

## Choose the smallest useful mode

Use the owner's selected channel, spending limit and deployment permissions. Check the current site and its hosting before choosing an implementation.

- Local mode matches approved FAQ cards in the browser. It needs static hosting, sends no question to a model and has no inference bill. Unrecognized or ambiguous questions move to clarification or a person.
- Optional model mode sends a bounded question and small context to a server-side classifier. The model returns permitted card identifiers or a routing status. The program displays approved text. It does not let the model invent product conditions.

Prefer local mode for initial zero-cost testing when it meets the measured question coverage. Do not present a deterministic FAQ as a general AI consultant. Preserve the user's choice when a model is required.

## Prepare the knowledge

Each card needs an identifier, approved answer, matching examples, near misses, an owner source, approval date and status. Resolve contradictory versions before release. Draft prices, schedules, discounts, guarantees and legal terms are not approved facts.

Organize answers around the visitor's actual decision. For a course, distinguish learning to do the work from purchasing a finished service. For another product, derive the relevant objections from its own evidence.

Use the schema and integration details in [implementation.md](references/implementation.md). The generic sample in [example-knowledge.json](assets/example-knowledge.json) demonstrates configuration; its fictional facts must be replaced.

## Build and test

Reuse the code in `assets/component/` rather than rebuilding a chat framework. Keep CSS, knowledge and backend settings isolated from unrelated site changes. Use `scripts/package_site.py` to create a local deployment package and a bounded HTML insertion; it does not upload anything.

Make contact and purchase actions available immediately. Do not require a diagnostic interview from someone ready to buy. A question outside the database should not be silently answered using a merely similar card. Short follow-ups need a small session context; substantial unknown parts need clarification or a handoff.

The handoff is a visible, editable summary and a contact link. The visitor sends the message. Opening a messenger is not proof of delivery. Keep a copyable fallback for clients that do not preserve the draft.

Run the core tests and the owner's own evaluation cases. Set expected answers before tuning the matcher. Check factual claims, near misses, multi-part questions, topic changes, injection attempts, API failures and the mobile handoff. Record observed coverage and failures; a curated test set is not a guarantee for future questions.

## Release and measure

Keep API credentials server-side, bound input and costs, and avoid storing full questions in routine logs. Before processing real visitors, establish appropriate data handling, provider terms and retention for the actual jurisdiction. A domestic database alone does not determine where a model processes text.

Verify the current site, make a restorable copy, run project checks and deploy only within the existing authorization. Inspect the published result. Never mark a local package as a live deployment.

Distinguish chat activity, contact-link clicks, actually received messages, bookings, confirmed payments and refunds. Use a random reference code when it helps connect events, with an explicit unknown category for missing attribution. At low traffic, use individual journeys to find problems; do not infer a conversion lift without a suitable comparison.
