# Phase 1.1: Extended database design

This directory contains only the database-design work for Phases 1 and 1.1. It does not
contain a Node.js project, an Express server, authentication code, routes,
controllers, frontend files, or Postman collections.

The schema targets MySQL 8.0.16 or newer. MySQL began enforcing `CHECK`
constraints in 8.0.16.

## Phase 1.1 artifacts

```text
supermarket-management-system/
└── database/
    ├── README.md    # requirements, data dictionary, relationships, and run guide
    └── schema.sql   # executable MySQL 8 schema
```

The extended schema contains these 54 tables:

- Organization/access: `branches`, `roles`, `permissions`, `role_permissions`,
  `employees`, `employee_branch_assignments`, `users`, `user_roles`.
- POS/tills: `pos_registers`, `till_sessions`, `till_cash_movements`.
- Catalog/parties/pricing: `units_of_measure`, `categories`, `brands`,
  `tax_rates`, `products`, `product_variants`, `product_packages`,
  `product_barcodes`, `suppliers`, `supplier_products`,
  `supplier_product_packages`, `customers`, `branch_variant_prices`,
  `branch_package_prices`.
- Inventory/ledger: `branch_inventory`, `inventory_transactions`,
  `inventory_transaction_items`, `inventory_lots`, `branch_lot_inventory`,
  `inventory_transaction_lot_allocations`.
- Procurement/receiving: `purchase_orders`, `purchase_order_items`,
  `goods_receipts`, `goods_receipt_items`, `goods_receipt_item_lots`.
- Sales/returns/payments: `sales`, `sale_items`, `sale_item_lots`,
  `return_reasons`, `sales_returns`, `sales_return_items`, `payment_methods`,
  `sale_payments`.
- Transfers/adjustments: `stock_transfers`, `stock_transfer_items`,
  `stock_transfer_item_lots`, `inventory_adjustments`,
  `inventory_adjustment_items`, `inventory_adjustment_item_lots`.
- Physical counts: `stock_counts`, `stock_count_participants`,
  `stock_count_items`.
- General audit: `audit_logs`.

### Phase 1.1 change set

The 20 new tables are `pos_registers`, `till_sessions`,
`till_cash_movements`, `product_packages`, `supplier_product_packages`,
`branch_package_prices`, `inventory_lots`, `branch_lot_inventory`,
`goods_receipt_item_lots`, `inventory_transaction_lot_allocations`,
`sale_item_lots`, `return_reasons`, `sales_returns`, `sales_return_items`,
`stock_transfer_item_lots`, `inventory_adjustment_item_lots`, `stock_counts`,
`stock_count_participants`, `stock_count_items`, and `audit_logs`.

The existing tables changed in Phase 1.1 are `product_variants`,
`product_barcodes`, `inventory_transaction_items`, `purchase_order_items`,
`goods_receipt_items`, `sales`, `sale_items`, `sale_payments`,
`stock_transfer_items`, and `inventory_adjustments`. No existing table was
deleted or replaced.

## 1. Requirements analysis

The system has four different kinds of data:

1. Shared master data: users, roles, employees, customers, suppliers, categories,
   products, variants, units, brands, tax rates, and barcodes.
2. Branch-specific operational data: staff assignments, selling-price overrides,
   POS registers, till sessions, current inventory balances, lot balances,
   purchases, receipts, sales, returns, payments, transfers, counts, and
   adjustments.
3. Historical transaction data: order/receipt/sale/transfer lines and the
   append-only inventory ledger.
4. Non-stock audit data: who changed important master or security records, with
   JSON before/after snapshots and request context.

The sellable and stockable entity is a **product variant**, not a product. For
example, “Orange Juice” is a product; “Orange Juice 500 ml” and “Orange Juice
1 litre” are two variants with different SKUs and barcodes. Every purchase,
receipt, inventory balance, sale, and transfer therefore ultimately identifies a
`product_variant_id`.

A **product package** describes how a variant is bought or sold without creating
a second stock identity. Coca-Cola 50cl remains one stockable variant; Bottle,
Pack of 6, and Carton of 24 are packages whose exact `DECIMAL` conversion factors
produce base bottle quantities. Purchase, receipt, sale, and return lines retain
the factor used at the time of the transaction.

Lot identity is global to a product variant, while lot quantity is held per
branch. `branch_inventory` remains the fast branch/variant total and
`branch_lot_inventory` is the matching per-lot projection. Lot allocation rows
connect receipts and every lot-aware stock document to the existing inventory
ledger, enabling traceability and future FEFO selection.

Physical checkout hardware and cashier responsibility are separate concepts:
registers belong to branches, till sessions bind one cashier to one register for
a period, and sales may reference both. Returns remain separate documents from
sales, while refund payments can identify the return they settle.

Ordering stock and receiving stock are different business events. A purchase
order does not increase stock; posting a goods receipt does. Likewise, a transfer
reduces source stock when dispatched and increases destination stock when
received. This makes in-transit stock visible and auditable.

Reports are derived from transaction tables and the inventory ledger. There is
intentionally no `reports` table.

## 2. Table data dictionary

The exact types, nullability, defaults, keys, and checks are in `schema.sql`.
The following is the purpose and column-level meaning of every table.

### Organization and access control

#### `branches`

One row per physical store. `branch_id` is the primary key; `branch_code` is the
stable unique business code; `branch_name` is the display name. `phone` and
`email` hold contact details. `address_line_1`, `address_line_2`, `city`,
`state_region`, `postal_code`, and `country_code` hold the address.
`currency_code` is the branch's ISO-style three-character operating currency;
`timezone` controls local business-date interpretation; `opened_on` is the
opening date; `status` supports deactivation without deleting history.
`created_at` and `updated_at` are audit timestamps.

#### `roles`

Authorization-role definitions. `role_id` is the primary key. `role_code` and
`role_name` are independently unique; `description` explains the role;
`is_active` disables new use without deleting assignments. `created_at` and
`updated_at` are audit timestamps.

#### `permissions`

Atomic capabilities for later role-based authorization. `permission_id` is the
primary key; `permission_code` is the unique machine-readable key;
`permission_name` and `description` are human-readable metadata. `created_at`
and `updated_at` are audit timestamps.

#### `role_permissions`

Many-to-many bridge between roles and permissions. The composite primary key is
(`role_id`, `permission_id`); both columns are foreign keys. `granted_at` records
when the capability was added to the role.

#### `employees`

Staff identity independent of login accounts and branch assignment history.
`employee_id` is the primary key; `employee_number` is the unique staff number;
`first_name`, `last_name`, `email`, and `phone` hold identity/contact data.
`hire_date`, `termination_date`, and `employment_status` hold employment state.
`created_at` and `updated_at` are audit timestamps.

#### `employee_branch_assignments`

Assignment/history bridge allowing an employee to work at multiple branches over
time. `assignment_id` is the primary key; `employee_id` and `branch_id` are
foreign keys; `job_title`, `started_on`, and `ended_on` describe the assignment;
`is_primary` marks the employee's main active branch. The generated
`active_primary_employee_id` exists only to enforce at most one open primary
assignment per employee. `created_at` and `updated_at` are audit timestamps.

#### `users`

Login-account storage for the later authentication phase. No authentication logic
is implemented in Phase 1. `user_id` is the primary key; nullable unique
`employee_id` creates the optional one-to-one employee/account link; `username`
and `email` are unique credentials; `password_hash` is sized for bcrypt hashes.
`is_active`, `must_change_password`, and `last_login_at` are account state.
`created_at` and `updated_at` are audit timestamps.

#### `user_roles`

Many-to-many bridge allowing a user to have multiple roles. The primary key is
`user_role_id`. `user_id` and `role_id` identify the grant; nullable
`branch_id` scopes it to one branch, while `NULL` means a system-wide grant.
Generated `branch_scope_guard` makes each user/role/scope combination unique.
`assigned_by_user_id` identifies the granting user when known; `assigned_at`
records the assignment time.

### POS registers and till sessions

#### `pos_registers` — new in Phase 1.1

Physical checkout terminals. `pos_register_id` is the primary key; `branch_id`
is the owning branch FK; `register_code` is unique within a branch;
`register_name` is descriptive; optional `terminal_identifier` is globally
unique; `status` supports active, inactive, and maintenance states.
`created_at` and `updated_at` are audit timestamps. The branch/status index lists
available registers, and the unique (`pos_register_id`, `branch_id`) key anchors
branch-safe till and sale foreign keys.

#### `till_sessions` — new in Phase 1.1

A cashier's accountable period on one register. `till_session_id` is the primary
key and `session_number` is unique. `branch_id`, `pos_register_id`, and
`cashier_employee_id` define the session; `opened_by_employee_id` and optional
`closed_by_employee_id` record the actors. `status`, `opened_at`, and `closed_at`
record lifecycle. `currency_code`, `opening_cash_amount`,
`expected_closing_cash_amount`, `actual_closing_cash_amount`, and
`cash_difference_amount` preserve reconciliation values. Generated
`active_register_guard` and `active_cashier_guard` prevent more than one
open/suspended session for the same register or cashier. Composite uniqueness
supports a sale FK that simultaneously validates branch, register, and cashier.
Indexes support branch, register, cashier, and actor/date queries; `notes`,
`created_at`, and `updated_at` complete the record.

#### `till_cash_movements` — new in Phase 1.1

Non-sale cash entering or leaving a till session, such as added float, a cash
drop, or a payout. `till_cash_movement_id` is the primary key;
`till_session_id` and `recorded_by_employee_id` are FKs; `movement_type`,
positive `amount`, `reason`, optional `reference_number`, and `occurred_at`
describe the event; `created_at` is append-only audit time. A nullable reference
is unique within a session, and session/time plus employee/time indexes support
reconciliation and review.

### Product catalog, suppliers, customers, and pricing

#### `units_of_measure`

Normalized units such as EACH, kg, g, litre, or ml. `unit_of_measure_id` is the
primary key; `unit_code` and `unit_name` are unique; `symbol` is the label used in
the UI; `allows_fraction` says whether fractional quantities are meaningful.
`created_at` and `updated_at` are audit timestamps.

#### `categories`

Hierarchical product classification. `category_id` is the primary key;
`parent_category_id` is the optional self-referencing parent; `category_code` is
globally unique; `category_name` is unique within its parent; `description` and
`is_active` are metadata. Generated `parent_scope_id` makes root-level name
uniqueness work despite MySQL's handling of `NULL` in unique indexes.
`created_at` and `updated_at` are audit timestamps.

#### `brands`

Normalized product brands. `brand_id` is the primary key; `brand_code` and
`brand_name` are unique; `description` and `is_active` are metadata;
`created_at` and `updated_at` are audit timestamps.

#### `tax_rates`

Reusable current tax definitions. `tax_rate_id` is the primary key; `tax_code` is
unique; `tax_name` is descriptive; `rate_percent` stores the percentage without
floating-point rounding; `is_inclusive` says whether shelf price includes tax;
`is_active` controls use. `created_at` and `updated_at` are audit timestamps.
Transaction lines retain tax snapshots so later tax changes do not rewrite
history.

#### `products`

The shared product concept. `product_id` is the primary key; `category_id`,
optional `brand_id`, and optional `tax_rate_id` are foreign keys; `product_code`
is the unique internal product-family code; `product_name` and `description`
describe it; `status` supports discontinuation. `created_at` and `updated_at` are
audit timestamps. There is deliberately no stock quantity or barcode here.

#### `product_variants`

The sellable SKU/size. `product_variant_id` is the primary key; `product_id` and
`unit_of_measure_id` are foreign keys; `sku` is globally unique; `variant_name`
is unique within a product; `size_value` and `units_per_pack` describe size and
consumer-facing composition; `is_fractional` permits weighed/fractional sales;
`lot_tracking_mode` controls whether lot allocation is optional or required and
`requires_expiry_date` identifies variants whose lots must carry expiry dates;
`default_selling_price` is the catalog fallback price; `status` controls sale/use.
`created_at` and `updated_at` are audit timestamps. There is deliberately no
overall stock quantity here.

#### `product_packages` — new in Phase 1.1

Normalized buying/selling units for one stockable variant. `product_package_id`
is the primary key; `product_variant_id` and `package_unit_of_measure_id` are
FKs; `package_code` is unique within the variant; `package_name` is descriptive;
`conversion_to_base_quantity` is an exact `DECIMAL(18,6)` factor.
`is_base_unit`, `is_purchasable`, and `is_sellable` control use;
`default_selling_price` is an optional package price; `status` supports
deactivation. Generated `base_variant_guard` enforces at most one base package
per variant while active, and a check requires every base-package definition to
convert at exactly 1.
Variant/status and unit indexes support configuration lookups; `created_at` and
`updated_at` are audit timestamps.

#### `product_barcodes`

One or more scan codes per product variant. `barcode_id` is the primary key;
`product_variant_id` is required and optional `product_package_id` assigns the
code to a Bottle, Pack, Carton, or other configured package; a composite FK
guarantees that the package belongs to the same variant. `barcode` is a globally
unique, case-sensitive string so leading zeroes are retained; `barcode_type`
records the standard; `is_primary` chooses the preferred code. Generated
`primary_variant_guard` and `primary_package_guard` enforce at most one primary
barcode in each variant/package scope. `created_at` and `updated_at` are audit
timestamps.

#### `suppliers`

Supplier master data. `supplier_id` is the primary key; `supplier_code` is unique;
`supplier_name`, `contact_name`, `email`, and `phone` are identity/contact data;
`tax_identifier` is optional and unique; the address fields are `address_line_1`,
`address_line_2`, `city`, `state_region`, `postal_code`, and `country_code`;
`payment_terms_days` stores negotiated terms; `status` deactivates or blocks a
supplier without deleting history. `created_at` and `updated_at` are audit
timestamps.

#### `supplier_products`

Many-to-many bridge between suppliers and variants. The composite primary key is
(`supplier_id`, `product_variant_id`). `supplier_sku` is the supplier's code;
`is_preferred` identifies the preferred source; `lead_time_days` and
`minimum_order_quantity` support procurement. Generated
`preferred_variant_guard` enforces at most one preferred supplier per variant.
`created_at` and `updated_at` are audit timestamps.

#### `supplier_product_packages` — new in Phase 1.1

Supplier-specific package offerings. The composite primary key is
(`supplier_id`, `product_package_id`); `product_variant_id` is retained as a
referential-integrity anchor. Composite FKs require both an existing
supplier/variant relationship and a package belonging to that variant.
`supplier_package_sku` is unique per supplier;
`minimum_package_quantity` and `is_active` control ordering. Reverse package and
variant indexes support sourcing queries; `created_at` and `updated_at` are audit
timestamps.

#### `customers`

City-wide customer/loyalty records. `customer_id` is the primary key;
`customer_number` is unique; `customer_type` distinguishes people and businesses;
`first_name`, `last_name`, and `business_name` hold the appropriate name;
`email`, `phone`, `loyalty_number`, and `date_of_birth` hold contact/loyalty data;
`status` supports blocking/deactivation. `created_at` and `updated_at` are audit
timestamps. Sales may omit `customer_id` for anonymous walk-ins.

#### `branch_variant_prices`

Optional current branch-specific override of the variant's default price. The
composite primary key is (`branch_id`, `product_variant_id`). `selling_price` is
the override; `effective_from` controls when it applies; `is_active` disables the
override; `updated_by_employee_id` records the actor. `created_at` and
`updated_at` are audit timestamps. Actual sale prices are still snapshotted on
sale items.

#### `branch_package_prices` — new in Phase 1.1

Current branch-specific selling-price overrides for packages. The composite
primary key is (`branch_id`, `product_package_id`); both are FKs.
`selling_price`, `effective_from`, and `is_active` define the override;
`updated_by_employee_id` records the actor. Reverse package and actor indexes
support price lookup/audit; `created_at` and `updated_at` are timestamps.

### Inventory and ledger

#### `branch_inventory`

The current balance for exactly one branch/variant pair. The composite primary key
is (`branch_id`, `product_variant_id`). `quantity_on_hand` is physical stock;
`reorder_level` and `reorder_quantity` support replenishment; `last_counted_at` is
the last physical
count; `version_number` supports optimistic concurrency in the later backend.
`created_at` and `updated_at` are audit timestamps. Pending transfer commitments
are derived from approved transfer lines rather than kept as an unaudited reserved
quantity. For lot-tracked variants, this total must equal the sum of the branch's
`branch_lot_inventory` balances.

#### `inventory_transactions`

Append-only-by-policy stock-ledger headers. `inventory_transaction_id` is the
primary key;
`branch_id` identifies the affected stock pool; `transaction_number` is globally
unique; `transaction_type` describes why stock changed;
`reversal_of_transaction_id` optionally points to the one transaction being
reversed; `occurred_at` is business time; `created_by_employee_id` is the actor;
`notes` explains the event; `created_at` is the audit timestamp. There is no
`updated_at` because posted ledger entries must be reversed, not edited. The
later service account and service layer must deny direct update/delete access.

#### `inventory_transaction_items`

Ledger detail lines. `inventory_transaction_item_id` is the primary key;
`inventory_transaction_id` and `product_variant_id` are foreign keys;
`line_number` is unique within the transaction; signed `quantity_change` is
positive for stock in and negative for stock out; nullable `unit_cost` is the
per-base-unit valuation snapshot; `created_at` is the audit timestamp. The added
unique (`inventory_transaction_item_id`, `product_variant_id`) key anchors
variant-safe lot allocations.

#### `inventory_lots` — new in Phase 1.1

Global batch/lot identity for a product variant. `inventory_lot_id` is the
primary key; `product_variant_id` is an FK; the case-sensitive `lot_number` is
unique within the variant; `manufactured_on` and `expires_on` retain available
dates; `status` supports active, quarantined, recalled, and closed lots;
`created_by_employee_id` and `notes` provide provenance. The FEFO index begins
with variant/status/expiry, while composite ID/variant uniqueness anchors all
lot-aware document FKs. `created_at` and `updated_at` are audit timestamps.

#### `branch_lot_inventory` — new in Phase 1.1

Fast current lot balance at one branch. The composite primary key is
(`branch_id`, `inventory_lot_id`); both are FKs. `quantity_on_hand` is the current
base-unit quantity; `status` can locally make a lot available, quarantined,
blocked, or depleted; `version_number` supports optimistic locking.
Branch/status and reverse-lot indexes support FEFO and traceability queries;
`created_at` and `updated_at` are audit timestamps. This projection supplements,
but does not replace, `branch_inventory`.

#### `inventory_transaction_lot_allocations` — new in Phase 1.1

Lot allocation for posted inventory-ledger lines. The primary key is
`inventory_transaction_lot_allocation_id`; `inventory_transaction_item_id`,
`inventory_lot_id`, and `product_variant_id` participate in composite FKs that
guarantee both sides use the same variant. Signed `quantity_change` and optional
per-base-unit `unit_cost` describe the lot movement; one ledger item/lot pair is
unique. Reverse lot/item indexes support traceability; `created_at` is the
append-only audit timestamp.

### Purchasing and stock receiving

#### `purchase_orders`

Supplier-order header; creating or approving it does not change inventory.
`purchase_order_id` is the primary key; `purchase_order_number` is globally
unique; `branch_id` is the destination; `supplier_id` is the vendor; `status`,
`ordered_at`, and `expected_at` track lifecycle; `created_by_employee_id` and
`approved_by_employee_id` are creation/approval actors;
`cancelled_by_employee_id` is the cancellation actor; `approved_at` and
`cancelled_at` complete the lifecycle trail; `supplier_quote_number` stores the
vendor reference; `currency_code`, `subtotal_amount`, `discount_amount`, `tax_amount`,
`shipping_amount`, and `total_amount` preserve document totals; `notes`,
`created_at`, and `updated_at` complete the audit record.

#### `purchase_order_items`

Purchase lines. `purchase_order_item_id` is the primary key;
`purchase_order_id` and `product_variant_id` are required FKs; optional
`product_package_id` is constrained to the same variant. `line_number` is unique
within the order; generated `package_scope_guard` allows the same variant in
different package forms while preventing duplicate package lines.
`item_description` is the historical snapshot; `ordered_package_quantity` and
`package_conversion_factor` produce base-unit `ordered_quantity` under an exact
row check. `unit_cost` is cost per ordered package; `discount_amount`,
`tax_rate_percent`, `tax_amount`, and `line_total` preserve agreed money;
`created_at` and `updated_at` are audit timestamps. Received quantity is derived
from posted goods-receipt items and is not duplicated here.

#### `goods_receipts`

Physical-delivery header, supporting multiple partial deliveries for one order.
`goods_receipt_id` is the primary key; `goods_receipt_number` is unique;
`purchase_order_id`, `branch_id`, and `supplier_id` are a composite-scoped link
to the purchase order; `inventory_transaction_id` is the optional unique posted
ledger transaction; `status` controls whether stock has changed;
`supplier_delivery_note` and `supplier_invoice_number` store vendor documents;
`received_at` and `posted_at` are business dates; `received_by_employee_id` is the
receiver; `notes`, `created_at`, and `updated_at` are audit data.

#### `goods_receipt_items`

Delivery lines. `goods_receipt_item_id` is the primary key; `goods_receipt_id`
and `purchase_order_id` guarantee the receipt/order scope;
`purchase_order_item_id` and `product_variant_id` identify and validate the
ordered SKU; `line_number` is unique within a receipt.
`package_quantity_accepted`, `package_quantity_rejected`, and the snapshotted
`package_conversion_factor` are checked against base-unit `quantity_accepted`
and `quantity_rejected`. Only accepted base quantity increases stock.
`actual_unit_cost` is per received package; `discount_amount`, `tax_amount`, and
`line_total` preserve delivered invoice values; `created_at` and `updated_at`
are audit timestamps.

#### `goods_receipt_item_lots` — new in Phase 1.1

Allocates an accepted receipt line across one or more lots before posting. The
primary key is `goods_receipt_item_lot_id`; `goods_receipt_item_id`,
`inventory_lot_id`, and `product_variant_id` use composite FKs to prevent a
variant mismatch. `quantity_received` is accepted base-unit quantity and
`unit_cost` is an optional per-base-unit lot valuation snapshot. Each receipt
item/lot pair is unique; reverse indexes support all receipts for a lot.
`created_at` and `updated_at` are audit timestamps.

### Sales and payments

#### `sales`

Branch-specific sale header. `sale_id` is the primary key; `sale_number` is
globally unique; `branch_id` is required; optional `pos_register_id` identifies
the checkout and optional `till_session_id` identifies the accountable cashier
session. Composite FKs guarantee that any referenced register belongs to the
sale branch and any session matches the branch, register, and cashier.
`customer_id` is optional;
`cashier_employee_id` is required; `inventory_transaction_id` is the sale's
unique stock-out ledger entry; `reversal_inventory_transaction_id` is the stock
reversal for a void; `status`, `sold_at`, `cancelled_at`, and `voided_at` track
lifecycle;
`currency_code`, `subtotal_amount`, `discount_amount`, `tax_amount`, and
`total_amount` preserve receipt totals; `notes`, `created_at`, and `updated_at`
complete the audit record.

#### `sale_items`

Sale lines. `sale_item_id` is the primary key; `sale_id` and
`product_variant_id` are foreign keys; optional `product_package_id` is
constrained to the same variant; `line_number` is unique within a sale;
nullable `barcode_id` records the code scanned and is constrained to the same
variant. `item_description`, `sku_snapshot`, and `package_name_snapshot`
preserve receipt text. `quantity` is the number of selected packages;
`package_conversion_factor` and base-unit `base_quantity` are checked exactly.
`unit_price` is per package; nullable `unit_cost` is per base unit;
`discount_amount`,
`tax_rate_percent`, `tax_amount`, and `line_total` preserve the sale and
cost-of-goods facts; `created_at` and `updated_at` are audit timestamps.

#### `sale_item_lots` — new in Phase 1.1

Pre/posting allocation of a sale item across source lots. `sale_item_lot_id` is
the primary key; `sale_item_id`, `inventory_lot_id`, and `product_variant_id`
use composite FKs to enforce the same SKU. `base_quantity_allocated` is the
positive base quantity selected from that lot; each sale item/lot pair is unique.
Reverse lot and item indexes support recall tracing; `created_at` and
`updated_at` are audit timestamps.

#### `return_reasons` — new in Phase 1.1

Reusable reason policy for returns. `return_reason_id` is the primary key;
`reason_code` and `reason_name` are unique; `description`,
`default_restockable`, `requires_approval`, and `is_active` configure behavior.
`created_at` and `updated_at` are audit timestamps.

#### `sales_returns` — new in Phase 1.1

Dedicated return header; it never changes the original sale into a return.
`sales_return_id` is the primary key and `return_number` is unique.
`original_sale_id` plus `branch_id` forms a branch-safe FK to the sale;
`customer_id` is optional; `processed_by_employee_id`,
`approved_by_employee_id`, and `cancelled_by_employee_id` record actors.
`approval_required`, `status`, `requested_at`, `approved_at`, `completed_at`, and
`cancelled_at` enforce row-local workflow. `inventory_transaction_id` optionally
links the unique CUSTOMER_RETURN stock-in ledger event when at least one item is
restocked. `refund_total_amount` is the historical header total; `notes`,
`created_at`, and `updated_at` are audit data. Indexes cover original sale,
branch/status, customer, actors, and ledger lookup.

#### `sales_return_items` — new in Phase 1.1

Returned products and disposition. `sales_return_item_id` is the primary key;
`sales_return_id` and `original_sale_id` prove header scope; optional
`original_sale_item_id` links the exact sold line when available.
`product_variant_id`, optional `product_package_id`, and optional
`inventory_lot_id` use variant-safe FKs; `return_reason_id` is required.
`line_number`, `item_description`, `sku_snapshot`, and
`package_name_snapshot` preserve history. `quantity_returned`, exact
`package_conversion_factor`, and `base_quantity_returned` preserve both customer
and stock units. `item_condition`, `is_restockable`, `refund_amount`, and `notes`
record disposition. Damaged or expired items cannot be marked restockable by the
row check; `created_at` and `updated_at` are audit timestamps.

#### `payment_methods`

Tender definitions such as cash, card, or mobile money. `payment_method_id` is the
primary key; `method_code` and `method_name` are unique; `method_type` classifies
the tender; `requires_reference` controls validation; `is_active` controls use;
`created_at` and `updated_at` are audit timestamps.

#### `sale_payments`

Individual customer payment/refund attempts, allowing split tender. `sale_payment_id`
is the primary key; `payment_number` is unique; `sale_id`, `payment_method_id`,
and `processed_by_employee_id` are foreign keys. Optional `sales_return_id`
uses a composite FK to prove that a refund belongs to that return's original
sale; when populated, `payment_type` must be `REFUND`. `payment_type` distinguishes
money received from refunds; `status` records processing outcome; `amount` and
`currency_code` are monetary facts; `external_reference` stores processor/bank
references; `paid_at`, `notes`, `created_at`, and `updated_at` are audit data.
Paid balance and payment status are derived from completed payment rows.

### Transfers and adjustments

#### `stock_transfers`

Inter-branch transfer header. `stock_transfer_id` is the primary key;
`transfer_number` is unique; `source_branch_id` and `destination_branch_id` must
differ; `status` tracks the workflow; `requested_by_employee_id`,
`approved_by_employee_id`, `dispatched_by_employee_id`,
`received_by_employee_id`, and `cancelled_by_employee_id` record actors;
`source_inventory_transaction_id` is the
unique stock-out ledger event; `destination_inventory_transaction_id` is the
unique stock-in event; `requested_at`, `approved_at`, `dispatched_at`,
`received_at`, and `cancelled_at` record all required dates; `notes`,
`created_at`, and `updated_at` complete the audit record.

#### `stock_transfer_items`

Transfer lines. `stock_transfer_item_id` is the primary key;
`stock_transfer_id` and `product_variant_id` are foreign keys; `line_number` is
unique within the transfer; `quantity_requested`, `quantity_dispatched`, and
`quantity_received` retain discrepancies and in-transit quantities; `notes`,
`created_at`, and `updated_at` are audit data.

#### `stock_transfer_item_lots` — new in Phase 1.1

Splits each transfer line by global lot identity. `stock_transfer_item_lot_id` is
the primary key; `stock_transfer_item_id`, `inventory_lot_id`, and
`product_variant_id` use composite variant-safe FKs. Base-unit
`quantity_requested`, `quantity_dispatched`, and `quantity_received` retain lot
discrepancies; each transfer item/lot pair is unique. Reverse lot/item indexes
support traceability; `created_at` and `updated_at` are audit timestamps.

#### `inventory_adjustments`

Controlled stock-correction header for counts, damage, expiry, theft, supplier
returns, or other corrections. `inventory_adjustment_id` is the primary key;
`adjustment_number` is unique; `branch_id` identifies the stock pool;
`adjustment_type`, `status`, and `reason` describe the correction;
`created_by_employee_id` and `approved_by_employee_id` separate duties, while
`cancelled_by_employee_id` records cancellation;
`inventory_transaction_id` is the unique posted ledger event; `adjusted_at`,
`approved_at`, `posted_at`, and `cancelled_at` are lifecycle dates; `created_at`
and `updated_at` are audit timestamps.

#### `inventory_adjustment_items`

Correction lines. `inventory_adjustment_item_id` is the primary key;
`inventory_adjustment_id` and `product_variant_id` are foreign keys;
`line_number` is unique within an adjustment; signed `quantity_change` adds or
removes stock; nullable `unit_cost` preserves valuation; `reason` supplies
line-level detail; `created_at` and `updated_at` are audit timestamps.

#### `inventory_adjustment_item_lots` — new in Phase 1.1

Splits an inventory-adjustment line across affected lots.
`inventory_adjustment_item_lot_id` is the primary key;
`inventory_adjustment_item_id`, `inventory_lot_id`, and `product_variant_id`
use composite variant-safe FKs. Signed `quantity_change` and optional
per-base-unit `unit_cost` record the lot correction; each adjustment item/lot
pair is unique. Reverse indexes support lot history; `created_at` and
`updated_at` are audit timestamps.

### Physical stock counting

#### `stock_counts` — new in Phase 1.1

Formal count-session header. `stock_count_id` is the primary key and
`count_number` is unique. `branch_id` is required; `count_type` distinguishes
full, cycle, and spot counts; `status` records draft through posting/cancellation.
`created_by_employee_id`, `approved_by_employee_id`, `posted_by_employee_id`,
and `cancelled_by_employee_id` are actor FKs. `started_at`, `completed_at`,
`approved_at`, `posted_at`, and `cancelled_at` have row-local lifecycle checks.
Optional unique `inventory_adjustment_id` is a same-branch composite FK to the
correction generated when variances are posted. Branch/status, actor, and
adjustment indexes support operations; `notes`, `created_at`, and `updated_at`
are audit data.

#### `stock_count_participants` — new in Phase 1.1

Many-to-many bridge for employees participating as counters, supervisors, or
observers. The composite primary key is (`stock_count_id`, `employee_id`); both
are FKs. `participant_role` and `assigned_at` describe involvement, and the
reverse employee index supports workload/history queries.

#### `stock_count_items` — new in Phase 1.1

Historical count observations. `stock_count_item_id` is the primary key;
`stock_count_id` and `product_variant_id` are required FKs; optional
`inventory_lot_id` permits lot-level counts and is constrained to the same
variant. `line_number` is unique within the count. `system_quantity` snapshots
the expected base quantity before any correction; `counted_quantity` is the
observation; row-local generated `variance_quantity` is counted minus system.
Generated `lot_scope_guard` prevents duplicate total/lot lines for a variant.
`counted_by_employee_id` and `counted_at` must appear together with the observed
quantity; nonzero variance requires `variance_reason`. `notes`, `created_at`,
and `updated_at` complete the audit record. Variant, lot, and counter indexes
support reconciliation.

### General audit

#### `audit_logs` — new in Phase 1.1

Append-only-by-policy audit events for important non-stock changes.
`audit_log_id` is the primary key; optional `user_id`, `employee_id`, and
`branch_id` provide responsibility/context FKs. `action_type`, `entity_type`,
and string `entity_record_id` identify the change; a string ID also supports
composite business keys. `occurred_at` records event time; JSON `before_values`
and `after_values` preserve structured snapshots; `ip_address`, `user_agent`,
`request_id`, and `notes` preserve request context; `created_at` is insertion
time. Entity, actor, branch, action, and request indexes support investigations.
There is deliberately no `updated_at`.

## 3. Keys, constraints, and indexes

Most entity tables use a `BIGINT UNSIGNED` surrogate primary key. Pair-association
tables use composite keys where suitable; `user_roles` uses a surrogate key
because its branch scope is nullable. Important uniqueness rules include branch
code, role/permission
code, username/email, employee number, category/product/brand codes, SKU,
barcode, supplier/customer codes, loyalty number, document numbers, the
branch/variant inventory pair, and line number within each document.

Nullable generated-column guards implement rules that ordinary MySQL unique
indexes cannot express: one active base package per variant, one primary barcode
per variant/package scope, one preferred supplier per variant, one active till
session per register/cashier, one open primary branch assignment per employee,
and one copy of a user/role grant in either global or branch scope. A similar
lot-scope guard makes non-lot and lot count-line uniqueness deterministic.

Row-local `CHECK` constraints enforce positive package factors, exact rounded
base quantities, lot date order, nonnegative balances/money, till cash
differences, return disposition rules, count observation integrity, and lifecycle
date/actor consistency. Composite FKs are used wherever a child carries a
redundant variant or branch solely to prove that both referenced parents share
that same scope.

Foreign keys use restrictive deletion for master and transaction data so history
cannot disappear accidentally. Cascades are limited to access-control
associations. Operational records should normally be deactivated, cancelled, voided,
or reversed rather than deleted.

Useful reporting/lookup indexes include:

- inventory by variant across branches;
- active registers and till sessions by branch/register/cashier;
- packages and package prices by variant/branch and supplier;
- FEFO lot lookup by variant/status/expiry and branch/status;
- lot allocations by source document, ledger item, and lot;
- ledger entries by branch/date, type/date, and variant/transaction;
- purchases by branch/status/date and supplier/date;
- receipts by order/date and branch/date;
- sales by branch/date, customer/date, and cashier/date;
- returns by original sale/date and branch/status/date;
- payment attempts by sale/status/date and tender/date;
- outgoing and incoming transfers by branch/status/request date;
- stock counts by branch/status/date and count items by variant/lot;
- audit events by entity, user, employee, branch, action, and request ID;
- transaction-line reverse indexes beginning with `product_variant_id`.

Low-selectivity Boolean columns are not indexed on their own.

## 4. Relationships

### One-to-one

- An employee has zero or one user account, and a user may have zero or one linked
  employee; `users.employee_id` is nullable and unique.
- A posted goods receipt has one inventory transaction, and that inventory
  transaction belongs to at most one goods receipt.
- A completed sale has one stock-out inventory transaction; a voided sale also
  has one unique reversal transaction.
- A posted adjustment has one unique inventory transaction.
- A dispatched/received transfer has one unique source/destination inventory
  transaction respectively.
- A completed restocking sales return has zero or one unique inventory
  transaction; a no-restock return legitimately has none.
- A posted stock count has zero or one unique inventory adjustment; a zero-
  variance count legitimately has none.

### One-to-many

- One product has many variants; one variant has many packages, barcodes, and
  lot identities; one package may have many barcodes.
- One category has many child categories and many products.
- One brand has many products; one tax rate has many products; one unit of
  measure has many variants.
- One branch has many registers, till sessions, sales, purchases, receipts,
  assignments, ledger entries, total/lot inventory rows, stock counts, and
  outgoing/incoming transfers.
- One POS register has many historical till sessions and sales; one till session
  has many cash movements and sales.
- One employee can process many sales, receipts, payments, purchases, transfers,
  and adjustments.
- One supplier has many purchase orders; one purchase order has many lines and
  many goods receipts; one receipt has many receipt lines.
- One purchase-order item can be referenced by many partial receipt lines.
- One customer can have many sales, while a sale may be anonymous.
- One sale has many sale items and many payments.
- One sale has many dedicated return headers; one return has many returned items
  and may have many linked refund payment rows.
- One payment method can be used by many sale payments.
- One transfer or adjustment has many lines.
- One inventory transaction has many signed inventory-transaction items.
- One inventory lot can have balances at many branches and appear in many
  receipt, sale, return, transfer, adjustment, count, and ledger-allocation rows.
- One physical stock count has many participants and count items.
- One inventory transaction may identify one earlier transaction that it reverses;
  an original transaction has at most one direct reversal in this design.

### Many-to-many resolved by associative tables

- Users and roles through branch-aware `user_roles`.
- Roles and permissions through `role_permissions`.
- Employees and branches through `employee_branch_assignments`.
- Suppliers and product variants through `supplier_products`.
- Suppliers and variant packages through `supplier_product_packages`.
- Branches and variants through `branch_inventory` and
  `branch_variant_prices`.
- Branches and lots through `branch_lot_inventory`.
- Branches and packages through `branch_package_prices`.
- Purchase orders and variants through `purchase_order_items`.
- Goods receipts and purchase-order items through `goods_receipt_items`.
- Goods-receipt items and lots through `goods_receipt_item_lots`.
- Sales and variants through `sale_items`.
- Sale items and lots through `sale_item_lots`.
- Sales returns and variants through `sales_return_items`.
- Transfers and variants through `stock_transfer_items`.
- Transfer items and lots through `stock_transfer_item_lots`.
- Adjustments and variants through `inventory_adjustment_items`.
- Adjustment items and lots through `inventory_adjustment_item_lots`.
- Inventory transactions and variants through `inventory_transaction_items`.
- Inventory-transaction items and lots through
  `inventory_transaction_lot_allocations`.
- Stock counts and employees through `stock_count_participants`.
- Stock counts and variants/lots through `stock_count_items`.

## 5. Text ERD

Notation: `A ───< B` means one A to many B rows; `A >───< B` is a
many-to-many relationship resolved by the table shown between them; `0..1` marks
an optional end.

```text
BRANCHES ───< EMPLOYEE_BRANCH_ASSIGNMENTS >─── EMPLOYEES 0..1 ─── 0..1 USERS
                                                            │
                                      USERS ───< USER_ROLES >─── ROLES
                                                   └── 0..1 BRANCHES (role scope)
                                                                    │
                                   ROLES ───< ROLE_PERMISSIONS >─── PERMISSIONS

BRANCHES ───< POS_REGISTERS ───< TILL_SESSIONS ───< TILL_CASH_MOVEMENTS
                                      │   └────────── EMPLOYEES (cashier)
                                      └───< SALES

CATEGORIES ───< CATEGORIES (parent/child)
    │
    └───< PRODUCTS >─── BRANDS
             │    └──── TAX_RATES
             └───< PRODUCT_VARIANTS >─── UNITS_OF_MEASURE
                         │
                         ├───< PRODUCT_PACKAGES >─── UNITS_OF_MEASURE
                         │             ├───< PRODUCT_BARCODES
                         │             ├───< BRANCH_PACKAGE_PRICES >─── BRANCHES
                         │             └───< SUPPLIER_PRODUCT_PACKAGES >─── SUPPLIERS
                         ├───< PRODUCT_BARCODES (legacy/base package scope allowed)
                         ├───< SUPPLIER_PRODUCTS >─── SUPPLIERS
                         ├───< BRANCH_VARIANT_PRICES >─── BRANCHES
                         └───< BRANCH_INVENTORY >─── BRANCHES

PRODUCT_VARIANTS ───< INVENTORY_LOTS ───< BRANCH_LOT_INVENTORY >─── BRANCHES
                              │
                              ├───< GOODS_RECEIPT_ITEM_LOTS
                              ├───< SALE_ITEM_LOTS
                              ├───< STOCK_TRANSFER_ITEM_LOTS
                              ├───< INVENTORY_ADJUSTMENT_ITEM_LOTS
                              └───< INVENTORY_TRANSACTION_LOT_ALLOCATIONS

SUPPLIERS ───< PURCHASE_ORDERS >─── BRANCHES
                       │
                       ├───< PURCHASE_ORDER_ITEMS >─── PRODUCT_PACKAGES
                       └───< GOODS_RECEIPTS ───< GOODS_RECEIPT_ITEMS
                                      │                    │
                                      │                    ├── PURCHASE_ORDER_ITEMS
                                      │                    └──< GOODS_RECEIPT_ITEM_LOTS >── INVENTORY_LOTS
                                      └── 0..1 INVENTORY_TRANSACTIONS

BRANCHES ───< SALES >─── 0..1 CUSTOMERS
                │
                ├──── EMPLOYEES (cashier)
                ├──── 0..1 POS_REGISTERS / TILL_SESSIONS
                ├───< SALE_ITEMS >─── PRODUCT_PACKAGES
                │          └───< SALE_ITEM_LOTS >─── INVENTORY_LOTS
                ├───< SALES_RETURNS ───< SALES_RETURN_ITEMS
                │          │                     ├── SALE_ITEMS (original, optional)
                │          │                     └── 0..1 INVENTORY_LOTS
                │          └── 0..1 INVENTORY_TRANSACTIONS
                ├───< SALE_PAYMENTS >─── PAYMENT_METHODS
                │          └── 0..1 SALES_RETURNS (refund link)
                └── 0..1 INVENTORY_TRANSACTIONS (+ optional void reversal)

BRANCHES (source) ───< STOCK_TRANSFERS >─── BRANCHES (destination)
                              │
                              ├───< STOCK_TRANSFER_ITEMS >─── PRODUCT_VARIANTS
                              │              └──< STOCK_TRANSFER_ITEM_LOTS >── INVENTORY_LOTS
                              └── source/destination INVENTORY_TRANSACTIONS

BRANCHES ───< INVENTORY_ADJUSTMENTS ───< INVENTORY_ADJUSTMENT_ITEMS
                         │                            │
                         │                            ├── PRODUCT_VARIANTS
                         │                            └──< INVENTORY_ADJUSTMENT_ITEM_LOTS
                         └── 0..1 INVENTORY_TRANSACTIONS

BRANCHES ───< INVENTORY_TRANSACTIONS ───< INVENTORY_TRANSACTION_ITEMS
                                                       │
                                                       ├── PRODUCT_VARIANTS
                                                       └──< INVENTORY_TRANSACTION_LOT_ALLOCATIONS

BRANCHES ───< STOCK_COUNTS ───< STOCK_COUNT_ITEMS >─── PRODUCT_VARIANTS
                    │                    └── 0..1 INVENTORY_LOTS
                    ├───< STOCK_COUNT_PARTICIPANTS >─── EMPLOYEES
                    └── 0..1 INVENTORY_ADJUSTMENTS

USERS / EMPLOYEES / BRANCHES ───< AUDIT_LOGS
```

## 6. Important design decisions

- Stock is stored only for a branch/variant pair, never on `products` or
  `product_variants`.
- Packages do not create duplicate stock SKUs. They convert an allowed buying or
  selling unit into the variant's base inventory quantity using
  `DECIMAL(18,6)`. Purchase, receipt, sale, and return rows snapshot the factor;
  base quantities are checked after deterministic three-decimal rounding.
- One global lot identity can move between branches. `branch_lot_inventory`
  stores its per-branch balance, while document-lot and ledger-lot allocations
  retain its receipt, sale, return, transfer, adjustment, and count history.
- `branch_inventory` is a fast current-balance projection. The inventory ledger
  is the auditable source of every posted change. For lot-tracked stock, the
  branch total, branch-lot balance, and ledger allocation must all update
  atomically in one MySQL transaction with row locking.
- Ledger rows are append-only. Corrections use reversal/adjustment entries rather
  than editing historical stock movements. This is enforced by the later
  service-layer commands and restricted database grants, not by DDL triggers in
  this bootstrap schema.
- Purchase ordering is separate from stock receiving, enabling partial receipts.
- Source inventory is deducted on transfer dispatch. Destination inventory is
  added on receipt. Dispatched minus received quantity is in transit or a recorded
  discrepancy; lot identity is preserved across the transfer.
- POS registers are branch-owned hardware. Till sessions provide cashier and
  cash-drawer accountability without making the sale header carry mutable shift
  totals. Non-sale cash movements are recorded separately.
- Product returns are dedicated documents. Only restockable return quantities
  create positive inventory movements; refunds remain `sale_payments` rows linked
  to the return.
- Physical counts preserve the expected quantity before adjustment. Posting a
  nonzero variance creates the existing adjustment/ledger workflow rather than
  directly editing stock.
- General audit events use JSON before/after values and are separate from the
  quantitative inventory ledger. They are written by the future service layer,
  not database triggers.
- Quantities use `DECIMAL(15,3)` for weighed goods. Money uses `DECIMAL`, never
  `FLOAT`; unit prices/costs have four decimal places and document totals have two.
- Barcode values are strings because leading zeroes and nonnumeric standards must
  survive unchanged; a barcode may identify a specific package.
- Historical price, cost, description, SKU, discount, and tax fields on document
  lines are intentional snapshots, not accidental duplication.
- Transaction subtotals and unit prices/costs are stored tax-exclusive. Tax is a
  separate amount, so `total = subtotal - discount + tax` is unambiguous even
  when a catalog tax definition says shelf prices are tax-inclusive; checkout
  converts that display price before persisting the sale.
- Payment rows are sale payments only and support split tender and refunds.
  Supplier accounts payable is a separate future domain, not a polymorphic payment
  foreign key.
- Reports are queries over transactions; no report-result table is created.

## 7. Assumptions and boundaries

- Each branch has one logical stock pool. Shelf, backroom, aisle, and bin locations
  are not part of Phase 1.1.
- Lots/batches and expiry dates are now supported. Serial numbers, warehouse bins,
  temperature logs, and recall-case workflows remain outside this phase.
- A product must have at least one variant before it can be sold; this cross-row
  rule is enforced by the later service layer.
- Every usable variant must have exactly one active base package with conversion
  1, and that package's unit of measure must match the variant's base inventory
  unit. Package conversion factors are immutable after transactional use;
  changing a real pack definition means deactivating it and creating another
  package.
- Fractional quantities are allowed by the schema. The later service layer will
  reject fractional package/stock quantities when the configured unit does not
  allow them. Base inventory is rounded to three decimal places.
- Negative on-hand inventory is disallowed.
- Employees can work at multiple branches over time. The later service layer must
  verify that an actor has an active assignment at the relevant branch and event
  date.
- Each purchase order has one supplier and one receiving branch. Every goods
  receipt is tied to a purchase order; partial receipts are supported.
- Purchase and receipt lines store both package quantity and base quantity. A
  carton of an existing variant is a package, not another variant, unless it is a
  genuinely different SKU/product configuration.
- A lot number is unique within a product variant and follows that lot across
  branches. Lots with unavailable expiry dates are ordered after dated lots by
  future FEFO logic; variants marked `requires_expiry_date` cannot accept them.
- Customer identification is optional for walk-in sales; cashier and branch are
  mandatory.
- Register/session links on `sales` remain nullable for legacy imports and
  non-register channels. A normal in-store POS sale must provide both, and its
  scanned barcode must belong to the selected package when the barcode is
  package-specific.
- One row stores the current optional branch-price override. Sale items preserve
  price history. Package overrides follow the same model. Scheduled price-list
  history can be added as a separate pricing domain if needed.
- Document currencies must match the branch currency unless a later foreign-
  currency purchasing feature explicitly records exchange rates.
- Header totals, lifecycle transitions, cumulative received quantities, payment
  totals, and matching ledger signs/types require multi-row checks and will be
  validated transactionally in the backend phase; MySQL `CHECK` constraints cover
  the row-local invariants now.
- Each inventory transaction may be linked to only one business document and one
  document role. The later posting service must enforce this cross-table rule;
  SQL `UNIQUE` constraints already prevent reuse within each individual source
  table.
- Gross-profit reporting uses perpetual weighted-average cost. The later sale
  completion transaction must calculate and populate every `sale_items.unit_cost`;
  it is nullable only while a sale is still open and is measured per base unit.
- MySQL does not permit a `CHECK` constraint to reference an `AUTO_INCREMENT`
  column. The later service layer must therefore reject category self-parenting
  and every longer category cycle, plus a ledger reversal that points to itself;
  the foreign keys still guarantee that any referenced row exists. The composite
  sale/reversal foreign key does guarantee that a void transaction reverses that
  sale's own stock-out transaction.

## 8. Enforcement boundaries

### Current database responsibilities

The database stores master configuration, immutable historical snapshots,
document workflow state, branch/variant totals, branch/lot totals, package/base
quantities, lot allocations, till reconciliation snapshots, returns, counts, and
general audit events. The inventory ledger remains the authoritative history of
posted stock changes; balance tables are controlled current-state projections.

### Rules enforced directly by MySQL

- Primary, foreign, composite-scope, and unique-key integrity.
- One active till session per register and cashier; at most one base package per
  variant and one primary barcode per package scope.
- Exact package-to-base arithmetic using `DECIMAL` and three-decimal rounding.
- Nonnegative balances/money, positive transaction quantities where applicable,
  date ordering, paired lifecycle actors/timestamps, and row-local status rules.
- Variant consistency across packages, lots, receipt allocations, sale
  allocations, returns, transfers, adjustments, counts, and ledger allocations.
- Same-branch links for registers/sessions/sales, receipt ledger entries, return
  ledger entries, transfer ledger entries, adjustments, and stock-count postings.
- JSON validity for audit before/after documents through MySQL's native `JSON`
  type.

### Rules for the future Node.js service layer

The following require queries across multiple rows/tables and must be enforced in
one database transaction where stock or money changes:

- Ensure every active variant has exactly one active base package; prevent
  conversion changes after use; require its package unit to match the variant's
  base inventory unit; validate package sellable/purchasable flags,
  package-specific barcodes, and supplier-package availability.
- Copy the configured conversion factor into document lines and validate package
  fractional quantities against the selected unit of measure.
- On receipt, sale, return, transfer, adjustment, or count posting: lock affected
  rows; insert the correctly typed/signed inventory transaction and lot
  allocations; update `branch_inventory` and `branch_lot_inventory`; verify the
  branch total equals the sum of lot balances for lot-tracked variants; commit all
  changes together and make posting idempotent.
- Require expiry dates where configured, block expired/recalled/quarantined lots
  from ordinary sales, and select eligible lots using FEFO. Confirm all document-
  lot allocation sums equal their base document quantities and all ledger-lot
  allocation sums equal their ledger item quantities with matching signs/costs.
- Verify employees have active assignments/permissions at the relevant branch;
  verify document currencies match the branch; enforce allowed lifecycle
  transitions and approval thresholds.
- Recalculate header totals from lines; cumulative received quantities from
  receipts; cumulative returned quantity against the original sale item; refund
  payments against the return total; and completed-sale weighted-average cost.
- At till close, calculate expected cash from opening cash, completed cash
  payments, completed cash refunds, and signed `till_cash_movements`; persist the
  snapshot, then let MySQL validate `actual - expected = difference`.
- Require all necessary stock-count lines to be counted, prevent overlapping
  count scopes, and generate a same-branch adjustment whose signed items exactly
  match nonzero count variances.
- Write `audit_logs` for important non-stock changes, including before/after JSON,
  actor, branch, and request context. Prevent updates/deletes to posted ledger,
  finalized documents, cash movements, and audit rows using service commands and
  restricted DB grants.
- Prevent one inventory transaction from being reused by different document
  families, validate its transaction type, and enforce category-tree acyclicity.

## 9. Running and verifying the schema

From the project root, connect with an account that can create databases:

```bash
mysql -u root -p < database/schema.sql
```

Or from inside the MySQL client:

```sql
SOURCE /absolute/path/to/supermarket-management-system/database/schema.sql;
```

Verify the database and tables:

```sql
SELECT VERSION();
USE supermarket_management;
SHOW TABLES;
SHOW CREATE TABLE product_packages\G
SHOW CREATE TABLE inventory_lots\G
SHOW CREATE TABLE till_sessions\G
SHOW CREATE TABLE sales_returns\G
SHOW CREATE TABLE stock_counts\G
SHOW CREATE TABLE branch_inventory\G
SHOW CREATE TABLE stock_transfers\G
```

Count the tables created through Phase 1.1 (the expected result is `54`):

```sql
SELECT COUNT(*) AS table_count
FROM information_schema.tables
WHERE table_schema = 'supermarket_management'
  AND table_type = 'BASE TABLE';
```

Count the declared foreign-key, unique-key, and check constraints:

```sql
SELECT COUNT(*) AS foreign_key_count
FROM information_schema.referential_constraints
WHERE constraint_schema = 'supermarket_management';

SELECT COUNT(*) AS unique_constraint_count
FROM information_schema.table_constraints
WHERE constraint_schema = 'supermarket_management'
  AND constraint_type = 'UNIQUE';

SELECT COUNT(*) AS check_constraint_count
FROM information_schema.table_constraints
WHERE constraint_schema = 'supermarket_management'
  AND constraint_type = 'CHECK';
```

Inspect foreign keys and indexes in detail:

```sql
SELECT table_name, constraint_name, referenced_table_name
FROM information_schema.referential_constraints
WHERE constraint_schema = 'supermarket_management'
ORDER BY table_name, constraint_name;

SELECT table_name, index_name, column_name, seq_in_index
FROM information_schema.statistics
WHERE table_schema = 'supermarket_management'
ORDER BY table_name, index_name, seq_in_index;
```

Check that every foreign-key column has the same MySQL type as the referenced
column. A compatible schema returns no rows:

```sql
SELECT kcu.table_name, kcu.column_name,
       child.column_type AS child_type,
       kcu.referenced_table_name, kcu.referenced_column_name,
       parent.column_type AS parent_type
FROM information_schema.key_column_usage AS kcu
JOIN information_schema.columns AS child
  ON child.table_schema = kcu.table_schema
 AND child.table_name = kcu.table_name
 AND child.column_name = kcu.column_name
JOIN information_schema.columns AS parent
  ON parent.table_schema = kcu.referenced_table_schema
 AND parent.table_name = kcu.referenced_table_name
 AND parent.column_name = kcu.referenced_column_name
WHERE kcu.table_schema = 'supermarket_management'
  AND kcu.referenced_table_name IS NOT NULL
  AND child.column_type <> parent.column_type;
```

`CREATE TABLE IF NOT EXISTS` makes this a safe bootstrap script for a matching
schema. It is not a migration system: it will not alter an older table definition
that already exists. The Phase 1.1 file is therefore the canonical clean-install
schema. Applying the same changes to an already populated 34-table database will
require a reviewed, backed-up, ordered migration; future schema changes should use
versioned migration files.

## 10. Phase 1.1 validation record

The final file was validated on 2026-09-04 with MySQL 8.0.46. A clean execution
completed without errors, and an immediate second execution of the unchanged
file also completed without errors. MySQL metadata reported:

- 54 base tables;
- 130 foreign-key constraints;
- 102 `UNIQUE` constraints, excluding primary keys;
- 138 enforced `CHECK` constraints; and
- zero foreign-key column pairs with incompatible MySQL types, character sets,
  or collations.

`SHOW CREATE TABLE` was inspected for `product_packages`, `till_sessions`,
`goods_receipt_item_lots`, `sales_returns`, and `stock_counts`. A rollback-only
integration test also exercised carton-to-base conversion, receipt/lot
traceability, package sales, POS/till linkage, a restockable return and refund,
lot-aware ledger entries, a posted physical-count adjustment, till variance,
and JSON audit snapshots. Its ledger, branch balance, and lot balance reconciled,
and the transaction rollback left no sample data behind.
