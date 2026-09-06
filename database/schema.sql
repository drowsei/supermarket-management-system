-- Supermarket Management System - Phase 1.1 extended database schema
-- Target: MySQL 8.0.16+ (CHECK constraints are enforced from 8.0.16)

CREATE DATABASE IF NOT EXISTS supermarket_management
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci;

USE supermarket_management;

-- =========================================================
-- Organization and access control
-- =========================================================

CREATE TABLE IF NOT EXISTS branches (
    branch_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    branch_code VARCHAR(20) NOT NULL,
    branch_name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) NULL,
    email VARCHAR(254) NULL,
    address_line_1 VARCHAR(255) NOT NULL,
    address_line_2 VARCHAR(255) NULL,
    city VARCHAR(100) NOT NULL,
    state_region VARCHAR(100) NULL,
    postal_code VARCHAR(20) NULL,
    country_code CHAR(2) NOT NULL,
    currency_code CHAR(3) NOT NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    opened_on DATE NULL,
    status ENUM('ACTIVE', 'INACTIVE', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (branch_id),
    CONSTRAINT uq_branches_code UNIQUE (branch_code),
    CONSTRAINT chk_branches_country_code CHECK (CHAR_LENGTH(country_code) = 2),
    CONSTRAINT chk_branches_currency_code CHECK (CHAR_LENGTH(currency_code) = 3)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS roles (
    role_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    role_code VARCHAR(50) NOT NULL,
    role_name VARCHAR(100) NOT NULL,
    description VARCHAR(500) NULL,
    is_active TINYINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (role_id),
    CONSTRAINT uq_roles_code UNIQUE (role_code),
    CONSTRAINT uq_roles_name UNIQUE (role_name),
    CONSTRAINT chk_roles_is_active CHECK (is_active IN (0, 1))
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS permissions (
    permission_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    permission_code VARCHAR(100) NOT NULL,
    permission_name VARCHAR(150) NOT NULL,
    description VARCHAR(500) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (permission_id),
    CONSTRAINT uq_permissions_code UNIQUE (permission_code)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id BIGINT UNSIGNED NOT NULL,
    permission_id BIGINT UNSIGNED NOT NULL,
    granted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (role_id, permission_id),
    KEY idx_role_permissions_permission (permission_id, role_id),
    CONSTRAINT fk_role_permissions_role
        FOREIGN KEY (role_id) REFERENCES roles (role_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_role_permissions_permission
        FOREIGN KEY (permission_id) REFERENCES permissions (permission_id)
        ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS employees (
    employee_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_number VARCHAR(32) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(254) NULL,
    phone VARCHAR(30) NULL,
    hire_date DATE NOT NULL,
    termination_date DATE NULL,
    employment_status ENUM('ACTIVE', 'ON_LEAVE', 'TERMINATED')
        NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (employee_id),
    CONSTRAINT uq_employees_number UNIQUE (employee_number),
    CONSTRAINT uq_employees_email UNIQUE (email),
    KEY idx_employees_name (last_name, first_name),
    KEY idx_employees_status (employment_status),
    CONSTRAINT chk_employees_dates CHECK (
        termination_date IS NULL OR termination_date >= hire_date
    ),
    CONSTRAINT chk_employees_termination_status CHECK (
        employment_status <> 'TERMINATED' OR termination_date IS NOT NULL
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS employee_branch_assignments (
    assignment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_id BIGINT UNSIGNED NOT NULL,
    branch_id BIGINT UNSIGNED NOT NULL,
    job_title VARCHAR(100) NOT NULL,
    started_on DATE NOT NULL,
    ended_on DATE NULL,
    is_primary TINYINT UNSIGNED NOT NULL DEFAULT 0,
    active_primary_employee_id BIGINT UNSIGNED
        GENERATED ALWAYS AS (
            CASE
                WHEN ended_on IS NULL AND is_primary = 1 THEN employee_id
                ELSE NULL
            END
        ) STORED,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (assignment_id),
    CONSTRAINT uq_employee_branch_start
        UNIQUE (employee_id, branch_id, started_on),
    CONSTRAINT uq_employee_active_primary
        UNIQUE (active_primary_employee_id),
    KEY idx_employee_assignments_branch (branch_id, ended_on, employee_id),
    KEY idx_employee_assignments_employee (employee_id, ended_on, branch_id),
    CONSTRAINT fk_employee_assignments_employee
        FOREIGN KEY (employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_employee_assignments_branch
        FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_employee_assignment_dates CHECK (
        ended_on IS NULL OR ended_on >= started_on
    ),
    CONSTRAINT chk_employee_assignment_primary CHECK (is_primary IN (0, 1))
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS users (
    user_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_id BIGINT UNSIGNED NULL,
    username VARCHAR(100) NOT NULL,
    email VARCHAR(254) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_active TINYINT UNSIGNED NOT NULL DEFAULT 1,
    must_change_password TINYINT UNSIGNED NOT NULL DEFAULT 0,
    last_login_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (user_id),
    CONSTRAINT uq_users_employee UNIQUE (employee_id),
    CONSTRAINT uq_users_username UNIQUE (username),
    CONSTRAINT uq_users_email UNIQUE (email),
    CONSTRAINT fk_users_employee
        FOREIGN KEY (employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_users_is_active CHECK (is_active IN (0, 1)),
    CONSTRAINT chk_users_must_change CHECK (must_change_password IN (0, 1))
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS user_roles (
    user_role_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    role_id BIGINT UNSIGNED NOT NULL,
    branch_id BIGINT UNSIGNED NULL,
    branch_scope_guard BIGINT UNSIGNED
        GENERATED ALWAYS AS (COALESCE(branch_id, 0)) STORED,
    assigned_by_user_id BIGINT UNSIGNED NULL,
    assigned_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (user_role_id),
    CONSTRAINT uq_user_roles_scope
        UNIQUE (user_id, role_id, branch_scope_guard),
    KEY idx_user_roles_role (role_id, user_id),
    KEY idx_user_roles_branch (branch_id, user_id, role_id),
    KEY idx_user_roles_assigned_by (assigned_by_user_id),
    CONSTRAINT fk_user_roles_user
        FOREIGN KEY (user_id) REFERENCES users (user_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_user_roles_role
        FOREIGN KEY (role_id) REFERENCES roles (role_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_user_roles_branch
        FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_user_roles_assigned_by
        FOREIGN KEY (assigned_by_user_id) REFERENCES users (user_id)
        ON UPDATE RESTRICT ON DELETE SET NULL
) ENGINE = InnoDB;

-- =========================================================
-- POS registers and cashier till sessions
-- =========================================================

CREATE TABLE IF NOT EXISTS pos_registers (
    pos_register_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    branch_id BIGINT UNSIGNED NOT NULL,
    register_code VARCHAR(30) NOT NULL,
    register_name VARCHAR(100) NOT NULL,
    terminal_identifier VARCHAR(150) NULL,
    status ENUM('ACTIVE', 'INACTIVE', 'MAINTENANCE')
        NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (pos_register_id),
    CONSTRAINT uq_pos_registers_branch_code UNIQUE (branch_id, register_code),
    CONSTRAINT uq_pos_registers_terminal UNIQUE (terminal_identifier),
    CONSTRAINT uq_pos_registers_id_branch
        UNIQUE (pos_register_id, branch_id),
    KEY idx_pos_registers_branch_status (branch_id, status),
    CONSTRAINT fk_pos_registers_branch
        FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_pos_registers_code CHECK (
        CHAR_LENGTH(TRIM(register_code)) > 0
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS till_sessions (
    till_session_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    session_number VARCHAR(50) NOT NULL,
    branch_id BIGINT UNSIGNED NOT NULL,
    pos_register_id BIGINT UNSIGNED NOT NULL,
    cashier_employee_id BIGINT UNSIGNED NOT NULL,
    opened_by_employee_id BIGINT UNSIGNED NOT NULL,
    closed_by_employee_id BIGINT UNSIGNED NULL,
    status ENUM('OPEN', 'SUSPENDED', 'CLOSED', 'CANCELLED')
        NOT NULL DEFAULT 'OPEN',
    opened_at DATETIME(6) NOT NULL,
    closed_at DATETIME(6) NULL,
    currency_code CHAR(3) NOT NULL,
    opening_cash_amount DECIMAL(19, 2) NOT NULL,
    expected_closing_cash_amount DECIMAL(19, 2) NULL,
    actual_closing_cash_amount DECIMAL(19, 2) NULL,
    cash_difference_amount DECIMAL(19, 2) NULL,
    active_register_guard BIGINT UNSIGNED
        GENERATED ALWAYS AS (
            CASE
                WHEN status IN ('OPEN', 'SUSPENDED') THEN pos_register_id
                ELSE NULL
            END
        ) STORED,
    active_cashier_guard BIGINT UNSIGNED
        GENERATED ALWAYS AS (
            CASE
                WHEN status IN ('OPEN', 'SUSPENDED') THEN cashier_employee_id
                ELSE NULL
            END
        ) STORED,
    notes VARCHAR(1000) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (till_session_id),
    CONSTRAINT uq_till_sessions_number UNIQUE (session_number),
    CONSTRAINT uq_till_sessions_active_register UNIQUE (active_register_guard),
    CONSTRAINT uq_till_sessions_active_cashier UNIQUE (active_cashier_guard),
    CONSTRAINT uq_till_sessions_sale_scope
        UNIQUE (
            till_session_id,
            branch_id,
            pos_register_id,
            cashier_employee_id
        ),
    KEY idx_till_sessions_branch_opened (branch_id, opened_at),
    KEY idx_till_sessions_register_opened (pos_register_id, opened_at),
    KEY idx_till_sessions_cashier_opened (cashier_employee_id, opened_at),
    KEY idx_till_sessions_opened_by (opened_by_employee_id),
    KEY idx_till_sessions_closed_by (closed_by_employee_id),
    CONSTRAINT fk_till_sessions_register_scope
        FOREIGN KEY (pos_register_id, branch_id)
        REFERENCES pos_registers (pos_register_id, branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_till_sessions_cashier
        FOREIGN KEY (cashier_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_till_sessions_opened_by
        FOREIGN KEY (opened_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_till_sessions_closed_by
        FOREIGN KEY (closed_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_till_sessions_opening_cash CHECK (opening_cash_amount >= 0.00),
    CONSTRAINT chk_till_sessions_currency CHECK (CHAR_LENGTH(currency_code) = 3),
    CONSTRAINT chk_till_sessions_dates CHECK (
        closed_at IS NULL OR closed_at >= opened_at
    ),
    CONSTRAINT chk_till_sessions_state CHECK (
        (status IN ('OPEN', 'SUSPENDED')
            AND closed_at IS NULL
            AND closed_by_employee_id IS NULL
            AND expected_closing_cash_amount IS NULL
            AND actual_closing_cash_amount IS NULL
            AND cash_difference_amount IS NULL)
        OR
        (status = 'CLOSED'
            AND closed_at IS NOT NULL
            AND closed_by_employee_id IS NOT NULL
            AND expected_closing_cash_amount IS NOT NULL
            AND expected_closing_cash_amount >= 0.00
            AND actual_closing_cash_amount IS NOT NULL
            AND actual_closing_cash_amount >= 0.00
            AND cash_difference_amount = ROUND(
                actual_closing_cash_amount - expected_closing_cash_amount,
                2
            ))
        OR
        (status = 'CANCELLED'
            AND closed_at IS NOT NULL
            AND closed_by_employee_id IS NOT NULL
            AND expected_closing_cash_amount IS NULL
            AND actual_closing_cash_amount IS NULL
            AND cash_difference_amount IS NULL)
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS till_cash_movements (
    till_cash_movement_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    till_session_id BIGINT UNSIGNED NOT NULL,
    movement_type ENUM('CASH_IN', 'CASH_OUT', 'CASH_DROP', 'PAYOUT') NOT NULL,
    amount DECIMAL(19, 2) NOT NULL,
    reason VARCHAR(500) NOT NULL,
    reference_number VARCHAR(100) NULL,
    recorded_by_employee_id BIGINT UNSIGNED NOT NULL,
    occurred_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (till_cash_movement_id),
    CONSTRAINT uq_till_cash_movements_reference
        UNIQUE (till_session_id, reference_number),
    KEY idx_till_cash_movements_session_time (till_session_id, occurred_at),
    KEY idx_till_cash_movements_employee_time
        (recorded_by_employee_id, occurred_at),
    CONSTRAINT fk_till_cash_movements_session
        FOREIGN KEY (till_session_id) REFERENCES till_sessions (till_session_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_till_cash_movements_employee
        FOREIGN KEY (recorded_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_till_cash_movements_amount CHECK (amount > 0.00),
    CONSTRAINT chk_till_cash_movements_reason CHECK (
        CHAR_LENGTH(TRIM(reason)) > 0
    )
) ENGINE = InnoDB;

-- =========================================================
-- Product catalog, pricing, suppliers, and customers
-- =========================================================

CREATE TABLE IF NOT EXISTS units_of_measure (
    unit_of_measure_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    unit_code VARCHAR(20) NOT NULL,
    unit_name VARCHAR(80) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    allows_fraction TINYINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (unit_of_measure_id),
    CONSTRAINT uq_units_code UNIQUE (unit_code),
    CONSTRAINT uq_units_name UNIQUE (unit_name),
    CONSTRAINT chk_units_allows_fraction CHECK (allows_fraction IN (0, 1))
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS categories (
    category_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    parent_category_id BIGINT UNSIGNED NULL,
    category_code VARCHAR(50) NOT NULL,
    category_name VARCHAR(120) NOT NULL,
    description VARCHAR(500) NULL,
    is_active TINYINT UNSIGNED NOT NULL DEFAULT 1,
    parent_scope_id BIGINT UNSIGNED
        GENERATED ALWAYS AS (COALESCE(parent_category_id, 0)) STORED,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (category_id),
    CONSTRAINT uq_categories_code UNIQUE (category_code),
    CONSTRAINT uq_categories_parent_name
        UNIQUE (parent_scope_id, category_name),
    KEY idx_categories_parent (parent_category_id),
    CONSTRAINT fk_categories_parent
        FOREIGN KEY (parent_category_id) REFERENCES categories (category_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_categories_is_active CHECK (is_active IN (0, 1))
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS brands (
    brand_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    brand_code VARCHAR(50) NOT NULL,
    brand_name VARCHAR(120) NOT NULL,
    description VARCHAR(500) NULL,
    is_active TINYINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (brand_id),
    CONSTRAINT uq_brands_code UNIQUE (brand_code),
    CONSTRAINT uq_brands_name UNIQUE (brand_name),
    CONSTRAINT chk_brands_is_active CHECK (is_active IN (0, 1))
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS tax_rates (
    tax_rate_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tax_code VARCHAR(30) NOT NULL,
    tax_name VARCHAR(100) NOT NULL,
    rate_percent DECIMAL(7, 4) NOT NULL DEFAULT 0.0000,
    is_inclusive TINYINT UNSIGNED NOT NULL DEFAULT 0,
    is_active TINYINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (tax_rate_id),
    CONSTRAINT uq_tax_rates_code UNIQUE (tax_code),
    CONSTRAINT chk_tax_rates_percent CHECK (
        rate_percent >= 0.0000 AND rate_percent <= 100.0000
    ),
    CONSTRAINT chk_tax_rates_inclusive CHECK (is_inclusive IN (0, 1)),
    CONSTRAINT chk_tax_rates_active CHECK (is_active IN (0, 1))
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS products (
    product_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    category_id BIGINT UNSIGNED NOT NULL,
    brand_id BIGINT UNSIGNED NULL,
    tax_rate_id BIGINT UNSIGNED NULL,
    product_code VARCHAR(50) NOT NULL,
    product_name VARCHAR(180) NOT NULL,
    description TEXT NULL,
    status ENUM('ACTIVE', 'INACTIVE', 'DISCONTINUED')
        NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (product_id),
    CONSTRAINT uq_products_code UNIQUE (product_code),
    KEY idx_products_category_status (category_id, status),
    KEY idx_products_brand (brand_id, product_name),
    KEY idx_products_tax_rate (tax_rate_id),
    KEY idx_products_name (product_name),
    CONSTRAINT fk_products_category
        FOREIGN KEY (category_id) REFERENCES categories (category_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_products_brand
        FOREIGN KEY (brand_id) REFERENCES brands (brand_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_products_tax_rate
        FOREIGN KEY (tax_rate_id) REFERENCES tax_rates (tax_rate_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS product_variants (
    product_variant_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_id BIGINT UNSIGNED NOT NULL,
    unit_of_measure_id BIGINT UNSIGNED NOT NULL,
    sku VARCHAR(64) NOT NULL,
    variant_name VARCHAR(120) NOT NULL,
    size_value DECIMAL(12, 3) NULL,
    units_per_pack DECIMAL(12, 3) NOT NULL DEFAULT 1.000,
    is_fractional TINYINT UNSIGNED NOT NULL DEFAULT 0,
    lot_tracking_mode ENUM('NONE', 'OPTIONAL', 'REQUIRED')
        NOT NULL DEFAULT 'NONE',
    requires_expiry_date TINYINT UNSIGNED NOT NULL DEFAULT 0,
    default_selling_price DECIMAL(19, 4) NOT NULL,
    status ENUM('ACTIVE', 'INACTIVE', 'DISCONTINUED')
        NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (product_variant_id),
    CONSTRAINT uq_product_variants_sku UNIQUE (sku),
    CONSTRAINT uq_product_variants_name UNIQUE (product_id, variant_name),
    KEY idx_product_variants_product_status (product_id, status),
    KEY idx_product_variants_unit (unit_of_measure_id),
    CONSTRAINT fk_product_variants_product
        FOREIGN KEY (product_id) REFERENCES products (product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_product_variants_unit
        FOREIGN KEY (unit_of_measure_id)
        REFERENCES units_of_measure (unit_of_measure_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_product_variants_size CHECK (
        size_value IS NULL OR size_value > 0.000
    ),
    CONSTRAINT chk_product_variants_pack CHECK (units_per_pack > 0.000),
    CONSTRAINT chk_product_variants_fractional CHECK (is_fractional IN (0, 1)),
    CONSTRAINT chk_product_variants_expiry CHECK (
        requires_expiry_date IN (0, 1)
        AND (requires_expiry_date = 0 OR lot_tracking_mode <> 'NONE')
    ),
    CONSTRAINT chk_product_variants_price CHECK (default_selling_price >= 0.0000)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS product_packages (
    product_package_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    package_unit_of_measure_id BIGINT UNSIGNED NOT NULL,
    package_code VARCHAR(50) NOT NULL,
    package_name VARCHAR(120) NOT NULL,
    conversion_to_base_quantity DECIMAL(18, 6) NOT NULL,
    is_base_unit TINYINT UNSIGNED NOT NULL DEFAULT 0,
    is_purchasable TINYINT UNSIGNED NOT NULL DEFAULT 1,
    is_sellable TINYINT UNSIGNED NOT NULL DEFAULT 1,
    default_selling_price DECIMAL(19, 4) NULL,
    status ENUM('ACTIVE', 'INACTIVE', 'DISCONTINUED')
        NOT NULL DEFAULT 'ACTIVE',
    base_variant_guard BIGINT UNSIGNED
        GENERATED ALWAYS AS (
            CASE
                WHEN is_base_unit = 1 AND status = 'ACTIVE'
                    THEN product_variant_id
                ELSE NULL
            END
        ) STORED,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (product_package_id),
    CONSTRAINT uq_product_packages_variant_code
        UNIQUE (product_variant_id, package_code),
    CONSTRAINT uq_product_packages_base UNIQUE (base_variant_guard),
    CONSTRAINT uq_product_packages_id_variant
        UNIQUE (product_package_id, product_variant_id),
    KEY idx_product_packages_variant_status (product_variant_id, status),
    KEY idx_product_packages_unit (package_unit_of_measure_id),
    CONSTRAINT fk_product_packages_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants (product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_product_packages_unit
        FOREIGN KEY (package_unit_of_measure_id)
        REFERENCES units_of_measure (unit_of_measure_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_product_packages_conversion CHECK (
        conversion_to_base_quantity > 0.000000
    ),
    CONSTRAINT chk_product_packages_base_conversion CHECK (
        is_base_unit = 0 OR conversion_to_base_quantity = 1.000000
    ),
    CONSTRAINT chk_product_packages_flags CHECK (
        is_base_unit IN (0, 1)
        AND is_purchasable IN (0, 1)
        AND is_sellable IN (0, 1)
    ),
    CONSTRAINT chk_product_packages_price CHECK (
        default_selling_price IS NULL OR default_selling_price >= 0.0000
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS product_barcodes (
    barcode_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    product_package_id BIGINT UNSIGNED NULL,
    barcode VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
    barcode_type ENUM(
        'EAN_8', 'UPC_A', 'EAN_13', 'GTIN_14',
        'CODE_128', 'PLU', 'INTERNAL', 'OTHER'
    ) NOT NULL DEFAULT 'OTHER',
    is_primary TINYINT UNSIGNED NOT NULL DEFAULT 0,
    primary_variant_guard BIGINT UNSIGNED
        GENERATED ALWAYS AS (
            CASE WHEN is_primary = 1 THEN product_variant_id ELSE NULL END
        ) STORED,
    primary_package_guard BIGINT UNSIGNED
        GENERATED ALWAYS AS (
            CASE
                WHEN is_primary = 1 THEN COALESCE(product_package_id, 0)
                ELSE NULL
            END
        ) STORED,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (barcode_id),
    CONSTRAINT uq_product_barcodes_barcode UNIQUE (barcode),
    CONSTRAINT uq_product_barcodes_primary
        UNIQUE (primary_variant_guard, primary_package_guard),
    CONSTRAINT uq_product_barcodes_id_variant
        UNIQUE (barcode_id, product_variant_id),
    KEY idx_product_barcodes_variant (product_variant_id),
    KEY idx_product_barcodes_package_variant
        (product_package_id, product_variant_id),
    CONSTRAINT fk_product_barcodes_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants (product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_product_barcodes_package
        FOREIGN KEY (product_package_id, product_variant_id)
        REFERENCES product_packages (product_package_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_product_barcodes_primary CHECK (is_primary IN (0, 1)),
    CONSTRAINT chk_product_barcodes_not_blank CHECK (
        CHAR_LENGTH(TRIM(barcode)) > 0
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS suppliers (
    supplier_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    supplier_code VARCHAR(32) NOT NULL,
    supplier_name VARCHAR(180) NOT NULL,
    contact_name VARCHAR(150) NULL,
    email VARCHAR(254) NULL,
    phone VARCHAR(30) NULL,
    tax_identifier VARCHAR(80) NULL,
    address_line_1 VARCHAR(255) NULL,
    address_line_2 VARCHAR(255) NULL,
    city VARCHAR(100) NULL,
    state_region VARCHAR(100) NULL,
    postal_code VARCHAR(20) NULL,
    country_code CHAR(2) NULL,
    payment_terms_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('ACTIVE', 'INACTIVE', 'BLOCKED') NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (supplier_id),
    CONSTRAINT uq_suppliers_code UNIQUE (supplier_code),
    CONSTRAINT uq_suppliers_tax_id UNIQUE (tax_identifier),
    KEY idx_suppliers_name (supplier_name),
    CONSTRAINT chk_suppliers_country_code CHECK (
        country_code IS NULL OR CHAR_LENGTH(country_code) = 2
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS supplier_products (
    supplier_id BIGINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    supplier_sku VARCHAR(100) NULL,
    is_preferred TINYINT UNSIGNED NOT NULL DEFAULT 0,
    lead_time_days SMALLINT UNSIGNED NULL,
    minimum_order_quantity DECIMAL(15, 3) NOT NULL DEFAULT 1.000,
    preferred_variant_guard BIGINT UNSIGNED
        GENERATED ALWAYS AS (
            CASE WHEN is_preferred = 1 THEN product_variant_id ELSE NULL END
        ) STORED,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (supplier_id, product_variant_id),
    CONSTRAINT uq_supplier_products_sku UNIQUE (supplier_id, supplier_sku),
    CONSTRAINT uq_supplier_products_preferred UNIQUE (preferred_variant_guard),
    KEY idx_supplier_products_variant (product_variant_id, supplier_id),
    CONSTRAINT fk_supplier_products_supplier
        FOREIGN KEY (supplier_id) REFERENCES suppliers (supplier_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_supplier_products_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants (product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_supplier_products_preferred CHECK (is_preferred IN (0, 1)),
    CONSTRAINT chk_supplier_products_minimum CHECK (
        minimum_order_quantity > 0.000
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS supplier_product_packages (
    supplier_id BIGINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    product_package_id BIGINT UNSIGNED NOT NULL,
    supplier_package_sku VARCHAR(100) NULL,
    minimum_package_quantity DECIMAL(15, 3) NOT NULL DEFAULT 1.000,
    is_active TINYINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (supplier_id, product_package_id),
    CONSTRAINT uq_supplier_package_sku
        UNIQUE (supplier_id, supplier_package_sku),
    KEY idx_supplier_packages_package (product_package_id, supplier_id),
    KEY idx_supplier_packages_variant
        (product_variant_id, supplier_id, product_package_id),
    CONSTRAINT fk_supplier_packages_supplier_variant
        FOREIGN KEY (supplier_id, product_variant_id)
        REFERENCES supplier_products (supplier_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_supplier_packages_package_variant
        FOREIGN KEY (product_package_id, product_variant_id)
        REFERENCES product_packages (product_package_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_supplier_packages_minimum CHECK (
        minimum_package_quantity > 0.000
    ),
    CONSTRAINT chk_supplier_packages_active CHECK (is_active IN (0, 1))
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS customers (
    customer_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    customer_number VARCHAR(32) NOT NULL,
    customer_type ENUM('INDIVIDUAL', 'BUSINESS')
        NOT NULL DEFAULT 'INDIVIDUAL',
    first_name VARCHAR(100) NULL,
    last_name VARCHAR(100) NULL,
    business_name VARCHAR(180) NULL,
    email VARCHAR(254) NULL,
    phone VARCHAR(30) NULL,
    loyalty_number VARCHAR(50) NULL,
    date_of_birth DATE NULL,
    status ENUM('ACTIVE', 'INACTIVE', 'BLOCKED') NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (customer_id),
    CONSTRAINT uq_customers_number UNIQUE (customer_number),
    CONSTRAINT uq_customers_loyalty UNIQUE (loyalty_number),
    KEY idx_customers_name (last_name, first_name),
    KEY idx_customers_business_name (business_name),
    KEY idx_customers_email (email),
    KEY idx_customers_phone (phone),
    CONSTRAINT chk_customers_name CHECK (
        (customer_type = 'INDIVIDUAL'
            AND first_name IS NOT NULL
            AND last_name IS NOT NULL)
        OR
        (customer_type = 'BUSINESS' AND business_name IS NOT NULL)
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS branch_variant_prices (
    branch_id BIGINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    selling_price DECIMAL(19, 4) NOT NULL,
    effective_from DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    is_active TINYINT UNSIGNED NOT NULL DEFAULT 1,
    updated_by_employee_id BIGINT UNSIGNED NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (branch_id, product_variant_id),
    KEY idx_branch_prices_variant (product_variant_id, branch_id),
    KEY idx_branch_prices_updated_by (updated_by_employee_id),
    CONSTRAINT fk_branch_prices_branch
        FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_prices_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants (product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_prices_employee
        FOREIGN KEY (updated_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_branch_prices_amount CHECK (selling_price >= 0.0000),
    CONSTRAINT chk_branch_prices_active CHECK (is_active IN (0, 1))
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS branch_package_prices (
    branch_id BIGINT UNSIGNED NOT NULL,
    product_package_id BIGINT UNSIGNED NOT NULL,
    selling_price DECIMAL(19, 4) NOT NULL,
    effective_from DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    is_active TINYINT UNSIGNED NOT NULL DEFAULT 1,
    updated_by_employee_id BIGINT UNSIGNED NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (branch_id, product_package_id),
    KEY idx_branch_package_prices_package (product_package_id, branch_id),
    KEY idx_branch_package_prices_updated_by (updated_by_employee_id),
    CONSTRAINT fk_branch_package_prices_branch
        FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_package_prices_package
        FOREIGN KEY (product_package_id)
        REFERENCES product_packages (product_package_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_package_prices_employee
        FOREIGN KEY (updated_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_branch_package_prices_amount CHECK (selling_price >= 0.0000),
    CONSTRAINT chk_branch_package_prices_active CHECK (is_active IN (0, 1))
) ENGINE = InnoDB;

-- =========================================================
-- Branch inventory and immutable stock ledger
-- =========================================================

CREATE TABLE IF NOT EXISTS branch_inventory (
    branch_id BIGINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    quantity_on_hand DECIMAL(15, 3) NOT NULL DEFAULT 0.000,
    reorder_level DECIMAL(15, 3) NOT NULL DEFAULT 0.000,
    reorder_quantity DECIMAL(15, 3) NOT NULL DEFAULT 0.000,
    last_counted_at DATETIME(6) NULL,
    version_number INT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (branch_id, product_variant_id),
    KEY idx_branch_inventory_variant (product_variant_id, branch_id),
    KEY idx_branch_inventory_reorder (branch_id, reorder_level, quantity_on_hand),
    CONSTRAINT fk_branch_inventory_branch
        FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_inventory_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants (product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_branch_inventory_on_hand CHECK (quantity_on_hand >= 0.000),
    CONSTRAINT chk_branch_inventory_reorder_level CHECK (reorder_level >= 0.000),
    CONSTRAINT chk_branch_inventory_reorder_qty CHECK (reorder_quantity >= 0.000)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS inventory_transactions (
    inventory_transaction_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    branch_id BIGINT UNSIGNED NOT NULL,
    transaction_number VARCHAR(50) NOT NULL,
    transaction_type ENUM(
        'OPENING_BALANCE', 'PURCHASE_RECEIPT', 'SALE', 'SALE_VOID',
        'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT',
        'CUSTOMER_RETURN', 'SUPPLIER_RETURN'
    ) NOT NULL,
    reversal_of_transaction_id BIGINT UNSIGNED NULL,
    occurred_at DATETIME(6) NOT NULL,
    created_by_employee_id BIGINT UNSIGNED NULL,
    notes VARCHAR(1000) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (inventory_transaction_id),
    CONSTRAINT uq_inventory_transactions_number UNIQUE (transaction_number),
    CONSTRAINT uq_inventory_transactions_reversal
        UNIQUE (reversal_of_transaction_id),
    CONSTRAINT uq_inventory_transactions_id_branch
        UNIQUE (inventory_transaction_id, branch_id),
    CONSTRAINT uq_inventory_txn_reversal_link
        UNIQUE (
            inventory_transaction_id,
            reversal_of_transaction_id,
            branch_id
        ),
    KEY idx_inventory_txn_reversal_branch
        (reversal_of_transaction_id, branch_id),
    KEY idx_inventory_txn_branch_time (branch_id, occurred_at),
    KEY idx_inventory_txn_type_time (transaction_type, occurred_at),
    KEY idx_inventory_txn_created_by (created_by_employee_id, occurred_at),
    CONSTRAINT fk_inventory_txn_branch
        FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_txn_reversal
        FOREIGN KEY (reversal_of_transaction_id, branch_id)
        REFERENCES inventory_transactions (inventory_transaction_id, branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_txn_employee
        FOREIGN KEY (created_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS inventory_transaction_items (
    inventory_transaction_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    inventory_transaction_id BIGINT UNSIGNED NOT NULL,
    line_number SMALLINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    quantity_change DECIMAL(15, 3) NOT NULL,
    unit_cost DECIMAL(19, 4) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (inventory_transaction_item_id),
    CONSTRAINT uq_inventory_txn_items_line
        UNIQUE (inventory_transaction_id, line_number),
    CONSTRAINT uq_inventory_txn_items_id_variant
        UNIQUE (inventory_transaction_item_id, product_variant_id),
    KEY idx_inventory_txn_items_variant
        (product_variant_id, inventory_transaction_id),
    CONSTRAINT fk_inventory_txn_items_transaction
        FOREIGN KEY (inventory_transaction_id)
        REFERENCES inventory_transactions (inventory_transaction_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_txn_items_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants (product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_txn_items_line CHECK (line_number > 0),
    CONSTRAINT chk_inventory_txn_items_quantity CHECK (quantity_change <> 0.000),
    CONSTRAINT chk_inventory_txn_items_cost CHECK (
        unit_cost IS NULL OR unit_cost >= 0.0000
    )
) ENGINE = InnoDB;

-- =========================================================
-- Purchasing and physical stock receiving
-- =========================================================

CREATE TABLE IF NOT EXISTS purchase_orders (
    purchase_order_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    purchase_order_number VARCHAR(50) NOT NULL,
    branch_id BIGINT UNSIGNED NOT NULL,
    supplier_id BIGINT UNSIGNED NOT NULL,
    status ENUM(
        'DRAFT', 'SUBMITTED', 'APPROVED',
        'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'
    ) NOT NULL DEFAULT 'DRAFT',
    ordered_at DATETIME(6) NULL,
    expected_at DATETIME(6) NULL,
    created_by_employee_id BIGINT UNSIGNED NOT NULL,
    approved_by_employee_id BIGINT UNSIGNED NULL,
    cancelled_by_employee_id BIGINT UNSIGNED NULL,
    approved_at DATETIME(6) NULL,
    cancelled_at DATETIME(6) NULL,
    supplier_quote_number VARCHAR(100) NULL,
    currency_code CHAR(3) NOT NULL,
    subtotal_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    discount_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    tax_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    shipping_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    total_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    notes VARCHAR(1000) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (purchase_order_id),
    CONSTRAINT uq_purchase_orders_number UNIQUE (purchase_order_number),
    CONSTRAINT uq_purchase_orders_id_branch_supplier
        UNIQUE (purchase_order_id, branch_id, supplier_id),
    KEY idx_purchase_orders_branch_status_date (branch_id, status, ordered_at),
    KEY idx_purchase_orders_supplier_date (supplier_id, ordered_at),
    KEY idx_purchase_orders_created_by (created_by_employee_id),
    KEY idx_purchase_orders_approved_by (approved_by_employee_id),
    KEY idx_purchase_orders_cancelled_by (cancelled_by_employee_id),
    CONSTRAINT fk_purchase_orders_branch
        FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_purchase_orders_supplier
        FOREIGN KEY (supplier_id) REFERENCES suppliers (supplier_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_purchase_orders_created_by
        FOREIGN KEY (created_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_purchase_orders_approved_by
        FOREIGN KEY (approved_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_purchase_orders_cancelled_by
        FOREIGN KEY (cancelled_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_purchase_orders_dates CHECK (
        expected_at IS NULL OR ordered_at IS NULL OR expected_at >= ordered_at
    ),
    CONSTRAINT chk_purchase_orders_state CHECK (
        (status = 'DRAFT'
            AND ordered_at IS NULL
            AND approved_at IS NULL
            AND cancelled_at IS NULL)
        OR
        (status = 'SUBMITTED'
            AND ordered_at IS NOT NULL
            AND approved_at IS NULL
            AND cancelled_at IS NULL)
        OR
        (status IN ('APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED')
            AND ordered_at IS NOT NULL
            AND approved_at IS NOT NULL
            AND cancelled_at IS NULL)
        OR
        (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
    ),
    CONSTRAINT chk_purchase_orders_actor_dates CHECK (
        ((approved_at IS NULL AND approved_by_employee_id IS NULL)
            OR (approved_at IS NOT NULL AND approved_by_employee_id IS NOT NULL))
        AND
        ((cancelled_at IS NULL AND cancelled_by_employee_id IS NULL)
            OR (cancelled_at IS NOT NULL
                AND cancelled_by_employee_id IS NOT NULL))
    ),
    CONSTRAINT chk_purchase_orders_lifecycle_dates CHECK (
        (approved_at IS NULL
            OR (ordered_at IS NOT NULL AND approved_at >= ordered_at))
        AND
        (cancelled_at IS NULL
            OR ordered_at IS NULL
            OR cancelled_at >= ordered_at)
        AND
        (cancelled_at IS NULL
            OR approved_at IS NULL
            OR cancelled_at >= approved_at)
    ),
    CONSTRAINT chk_purchase_orders_amounts CHECK (
        subtotal_amount >= 0.00
        AND discount_amount >= 0.00
        AND discount_amount <= subtotal_amount
        AND tax_amount >= 0.00
        AND shipping_amount >= 0.00
        AND total_amount >= 0.00
    ),
    CONSTRAINT chk_purchase_orders_total CHECK (
        total_amount = ROUND(
            subtotal_amount - discount_amount + tax_amount + shipping_amount,
            2
        )
    ),
    CONSTRAINT chk_purchase_orders_currency CHECK (CHAR_LENGTH(currency_code) = 3)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS purchase_order_items (
    purchase_order_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    purchase_order_id BIGINT UNSIGNED NOT NULL,
    line_number SMALLINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    product_package_id BIGINT UNSIGNED NULL,
    item_description VARCHAR(255) NOT NULL,
    ordered_package_quantity DECIMAL(15, 3) NOT NULL,
    package_conversion_factor DECIMAL(18, 6) NOT NULL DEFAULT 1.000000,
    ordered_quantity DECIMAL(15, 3) NOT NULL,
    unit_cost DECIMAL(19, 4) NOT NULL,
    discount_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    tax_rate_percent DECIMAL(7, 4) NOT NULL DEFAULT 0.0000,
    tax_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    line_total DECIMAL(19, 2) NOT NULL,
    package_scope_guard BIGINT UNSIGNED
        GENERATED ALWAYS AS (COALESCE(product_package_id, 0)) STORED,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (purchase_order_item_id),
    CONSTRAINT uq_purchase_order_items_line
        UNIQUE (purchase_order_id, line_number),
    CONSTRAINT uq_purchase_order_items_package
        UNIQUE (
            purchase_order_id,
            product_variant_id,
            package_scope_guard
        ),
    CONSTRAINT uq_purchase_order_items_id_order
        UNIQUE (purchase_order_item_id, purchase_order_id),
    CONSTRAINT uq_purchase_order_items_receipt_scope
        UNIQUE (
            purchase_order_item_id,
            purchase_order_id,
            product_variant_id
        ),
    KEY idx_purchase_order_items_variant
        (product_variant_id, purchase_order_id),
    KEY idx_purchase_order_items_package_variant
        (product_package_id, product_variant_id),
    CONSTRAINT fk_purchase_order_items_order
        FOREIGN KEY (purchase_order_id)
        REFERENCES purchase_orders (purchase_order_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_purchase_order_items_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants (product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_purchase_order_items_package
        FOREIGN KEY (product_package_id, product_variant_id)
        REFERENCES product_packages (product_package_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_purchase_order_items_line CHECK (line_number > 0),
    CONSTRAINT chk_purchase_order_items_quantity CHECK (
        ordered_package_quantity > 0.000
        AND ordered_quantity > 0.000
        AND package_conversion_factor > 0.000000
        AND ordered_quantity = ROUND(
            ordered_package_quantity * package_conversion_factor,
            3
        )
    ),
    CONSTRAINT chk_purchase_order_items_legacy_package CHECK (
        product_package_id IS NOT NULL
        OR package_conversion_factor = 1.000000
    ),
    CONSTRAINT chk_purchase_order_items_cost CHECK (unit_cost >= 0.0000),
    CONSTRAINT chk_purchase_order_items_discount CHECK (discount_amount >= 0.00),
    CONSTRAINT chk_purchase_order_items_tax_rate CHECK (
        tax_rate_percent >= 0.0000 AND tax_rate_percent <= 100.0000
    ),
    CONSTRAINT chk_purchase_order_items_tax CHECK (tax_amount >= 0.00),
    CONSTRAINT chk_purchase_order_items_total CHECK (line_total >= 0.00)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS goods_receipts (
    goods_receipt_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    goods_receipt_number VARCHAR(50) NOT NULL,
    purchase_order_id BIGINT UNSIGNED NOT NULL,
    branch_id BIGINT UNSIGNED NOT NULL,
    supplier_id BIGINT UNSIGNED NOT NULL,
    inventory_transaction_id BIGINT UNSIGNED NULL,
    status ENUM('DRAFT', 'POSTED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    supplier_delivery_note VARCHAR(100) NULL,
    supplier_invoice_number VARCHAR(100) NULL,
    received_at DATETIME(6) NULL,
    posted_at DATETIME(6) NULL,
    received_by_employee_id BIGINT UNSIGNED NOT NULL,
    notes VARCHAR(1000) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (goods_receipt_id),
    CONSTRAINT uq_goods_receipts_number UNIQUE (goods_receipt_number),
    CONSTRAINT uq_goods_receipts_inventory_txn UNIQUE (inventory_transaction_id),
    CONSTRAINT uq_goods_receipts_supplier_invoice
        UNIQUE (supplier_id, supplier_invoice_number),
    CONSTRAINT uq_goods_receipts_id_order
        UNIQUE (goods_receipt_id, purchase_order_id),
    KEY idx_goods_receipts_order_date (purchase_order_id, received_at),
    KEY idx_goods_receipts_branch_date (branch_id, received_at),
    KEY idx_goods_receipts_supplier_date (supplier_id, received_at),
    KEY idx_goods_receipts_employee (received_by_employee_id),
    KEY idx_goods_receipts_txn_branch (inventory_transaction_id, branch_id),
    CONSTRAINT fk_goods_receipts_order_scope
        FOREIGN KEY (purchase_order_id, branch_id, supplier_id)
        REFERENCES purchase_orders (purchase_order_id, branch_id, supplier_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_goods_receipts_inventory_txn
        FOREIGN KEY (inventory_transaction_id, branch_id)
        REFERENCES inventory_transactions (inventory_transaction_id, branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_goods_receipts_employee
        FOREIGN KEY (received_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_goods_receipts_state CHECK (
        (status = 'POSTED'
            AND inventory_transaction_id IS NOT NULL
            AND received_at IS NOT NULL
            AND posted_at IS NOT NULL)
        OR
        (status IN ('DRAFT', 'CANCELLED')
            AND inventory_transaction_id IS NULL
            AND posted_at IS NULL)
    ),
    CONSTRAINT chk_goods_receipts_dates CHECK (
        posted_at IS NULL OR received_at IS NULL OR posted_at >= received_at
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS goods_receipt_items (
    goods_receipt_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    goods_receipt_id BIGINT UNSIGNED NOT NULL,
    purchase_order_id BIGINT UNSIGNED NOT NULL,
    purchase_order_item_id BIGINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    line_number SMALLINT UNSIGNED NOT NULL,
    package_quantity_accepted DECIMAL(15, 3) NOT NULL DEFAULT 0.000,
    package_quantity_rejected DECIMAL(15, 3) NOT NULL DEFAULT 0.000,
    package_conversion_factor DECIMAL(18, 6) NOT NULL DEFAULT 1.000000,
    quantity_accepted DECIMAL(15, 3) NOT NULL DEFAULT 0.000,
    quantity_rejected DECIMAL(15, 3) NOT NULL DEFAULT 0.000,
    actual_unit_cost DECIMAL(19, 4) NOT NULL,
    discount_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    tax_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    line_total DECIMAL(19, 2) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (goods_receipt_item_id),
    CONSTRAINT uq_goods_receipt_items_line
        UNIQUE (goods_receipt_id, line_number),
    CONSTRAINT uq_goods_receipt_items_order_item
        UNIQUE (goods_receipt_id, purchase_order_item_id),
    CONSTRAINT uq_goods_receipt_items_id_variant
        UNIQUE (goods_receipt_item_id, product_variant_id),
    KEY idx_goods_receipt_items_order_item
        (purchase_order_item_id, purchase_order_id, product_variant_id),
    KEY idx_goods_receipt_items_receipt_order
        (goods_receipt_id, purchase_order_id),
    CONSTRAINT fk_goods_receipt_items_receipt
        FOREIGN KEY (goods_receipt_id, purchase_order_id)
        REFERENCES goods_receipts (goods_receipt_id, purchase_order_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_goods_receipt_items_order_item
        FOREIGN KEY (
            purchase_order_item_id,
            purchase_order_id,
            product_variant_id
        )
        REFERENCES purchase_order_items
            (
                purchase_order_item_id,
                purchase_order_id,
                product_variant_id
            )
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_goods_receipt_items_line CHECK (line_number > 0),
    CONSTRAINT chk_goods_receipt_items_quantities CHECK (
        package_quantity_accepted >= 0.000
        AND package_quantity_rejected >= 0.000
        AND package_quantity_accepted + package_quantity_rejected > 0.000
        AND package_conversion_factor > 0.000000
        AND quantity_accepted >= 0.000
        AND quantity_rejected >= 0.000
        AND quantity_accepted + quantity_rejected > 0.000
        AND quantity_accepted = ROUND(
            package_quantity_accepted * package_conversion_factor,
            3
        )
        AND quantity_rejected = ROUND(
            package_quantity_rejected * package_conversion_factor,
            3
        )
    ),
    CONSTRAINT chk_goods_receipt_items_cost CHECK (actual_unit_cost >= 0.0000),
    CONSTRAINT chk_goods_receipt_items_discount CHECK (discount_amount >= 0.00),
    CONSTRAINT chk_goods_receipt_items_tax CHECK (tax_amount >= 0.00),
    CONSTRAINT chk_goods_receipt_items_total CHECK (line_total >= 0.00)
) ENGINE = InnoDB;

-- =========================================================
-- Lot/batch identity, receipt allocation, and branch balances
-- =========================================================

CREATE TABLE IF NOT EXISTS inventory_lots (
    inventory_lot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    lot_number VARCHAR(100)
        CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
    manufactured_on DATE NULL,
    expires_on DATE NULL,
    status ENUM('ACTIVE', 'QUARANTINED', 'RECALLED', 'CLOSED')
        NOT NULL DEFAULT 'ACTIVE',
    created_by_employee_id BIGINT UNSIGNED NULL,
    notes VARCHAR(1000) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (inventory_lot_id),
    CONSTRAINT uq_inventory_lots_variant_number
        UNIQUE (product_variant_id, lot_number),
    CONSTRAINT uq_inventory_lots_id_variant
        UNIQUE (inventory_lot_id, product_variant_id),
    KEY idx_inventory_lots_fefo
        (product_variant_id, status, expires_on, inventory_lot_id),
    KEY idx_inventory_lots_created_by (created_by_employee_id),
    CONSTRAINT fk_inventory_lots_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants (product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_lots_created_by
        FOREIGN KEY (created_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_lots_number CHECK (
        CHAR_LENGTH(TRIM(lot_number)) > 0
    ),
    CONSTRAINT chk_inventory_lots_dates CHECK (
        manufactured_on IS NULL
        OR expires_on IS NULL
        OR expires_on >= manufactured_on
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS branch_lot_inventory (
    branch_id BIGINT UNSIGNED NOT NULL,
    inventory_lot_id BIGINT UNSIGNED NOT NULL,
    quantity_on_hand DECIMAL(15, 3) NOT NULL DEFAULT 0.000,
    status ENUM('AVAILABLE', 'QUARANTINED', 'BLOCKED', 'DEPLETED')
        NOT NULL DEFAULT 'AVAILABLE',
    version_number INT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (branch_id, inventory_lot_id),
    KEY idx_branch_lot_inventory_lot (inventory_lot_id, branch_id),
    KEY idx_branch_lot_inventory_status (branch_id, status, inventory_lot_id),
    CONSTRAINT fk_branch_lot_inventory_branch
        FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_branch_lot_inventory_lot
        FOREIGN KEY (inventory_lot_id)
        REFERENCES inventory_lots (inventory_lot_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_branch_lot_inventory_quantity CHECK (
        quantity_on_hand >= 0.000
    ),
    CONSTRAINT chk_branch_lot_inventory_depleted CHECK (
        status <> 'DEPLETED' OR quantity_on_hand = 0.000
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS goods_receipt_item_lots (
    goods_receipt_item_lot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    goods_receipt_item_id BIGINT UNSIGNED NOT NULL,
    inventory_lot_id BIGINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    quantity_received DECIMAL(15, 3) NOT NULL,
    unit_cost DECIMAL(19, 4) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (goods_receipt_item_lot_id),
    CONSTRAINT uq_goods_receipt_item_lots
        UNIQUE (goods_receipt_item_id, inventory_lot_id),
    KEY idx_goods_receipt_lots_lot (inventory_lot_id, goods_receipt_item_id),
    KEY idx_goods_receipt_lots_item_variant
        (goods_receipt_item_id, product_variant_id),
    CONSTRAINT fk_goods_receipt_lots_item_variant
        FOREIGN KEY (goods_receipt_item_id, product_variant_id)
        REFERENCES goods_receipt_items
            (goods_receipt_item_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_goods_receipt_lots_lot_variant
        FOREIGN KEY (inventory_lot_id, product_variant_id)
        REFERENCES inventory_lots (inventory_lot_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_goods_receipt_lots_quantity CHECK (quantity_received > 0.000),
    CONSTRAINT chk_goods_receipt_lots_cost CHECK (
        unit_cost IS NULL OR unit_cost >= 0.0000
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS inventory_transaction_lot_allocations (
    inventory_transaction_lot_allocation_id BIGINT UNSIGNED
        NOT NULL AUTO_INCREMENT,
    inventory_transaction_item_id BIGINT UNSIGNED NOT NULL,
    inventory_lot_id BIGINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    quantity_change DECIMAL(15, 3) NOT NULL,
    unit_cost DECIMAL(19, 4) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (inventory_transaction_lot_allocation_id),
    CONSTRAINT uq_inventory_txn_lot_allocation
        UNIQUE (inventory_transaction_item_id, inventory_lot_id),
    KEY idx_inventory_txn_lot_alloc_lot
        (inventory_lot_id, inventory_transaction_item_id),
    KEY idx_inventory_txn_lot_alloc_item_variant
        (inventory_transaction_item_id, product_variant_id),
    CONSTRAINT fk_inventory_txn_lot_alloc_item_variant
        FOREIGN KEY (inventory_transaction_item_id, product_variant_id)
        REFERENCES inventory_transaction_items
            (inventory_transaction_item_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_txn_lot_alloc_lot_variant
        FOREIGN KEY (inventory_lot_id, product_variant_id)
        REFERENCES inventory_lots (inventory_lot_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_txn_lot_alloc_quantity CHECK (
        quantity_change <> 0.000
    ),
    CONSTRAINT chk_inventory_txn_lot_alloc_cost CHECK (
        unit_cost IS NULL OR unit_cost >= 0.0000
    )
) ENGINE = InnoDB;

-- =========================================================
-- Sales and customer payments
-- =========================================================

CREATE TABLE IF NOT EXISTS sales (
    sale_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sale_number VARCHAR(50) NOT NULL,
    branch_id BIGINT UNSIGNED NOT NULL,
    pos_register_id BIGINT UNSIGNED NULL,
    till_session_id BIGINT UNSIGNED NULL,
    customer_id BIGINT UNSIGNED NULL,
    cashier_employee_id BIGINT UNSIGNED NOT NULL,
    inventory_transaction_id BIGINT UNSIGNED NULL,
    reversal_inventory_transaction_id BIGINT UNSIGNED NULL,
    status ENUM('OPEN', 'COMPLETED', 'CANCELLED', 'VOIDED')
        NOT NULL DEFAULT 'OPEN',
    sold_at DATETIME(6) NULL,
    cancelled_at DATETIME(6) NULL,
    voided_at DATETIME(6) NULL,
    currency_code CHAR(3) NOT NULL,
    subtotal_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    discount_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    tax_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    total_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    notes VARCHAR(1000) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (sale_id),
    CONSTRAINT uq_sales_number UNIQUE (sale_number),
    CONSTRAINT uq_sales_inventory_txn UNIQUE (inventory_transaction_id),
    CONSTRAINT uq_sales_reversal_txn UNIQUE (reversal_inventory_transaction_id),
    CONSTRAINT uq_sales_id_branch UNIQUE (sale_id, branch_id),
    KEY idx_sales_branch_date (branch_id, sold_at),
    KEY idx_sales_customer_date (customer_id, sold_at),
    KEY idx_sales_cashier_date (cashier_employee_id, sold_at),
    KEY idx_sales_register_date (pos_register_id, sold_at),
    KEY idx_sales_till_session_scope
        (till_session_id, branch_id, pos_register_id, cashier_employee_id),
    KEY idx_sales_status_date (status, sold_at),
    KEY idx_sales_txn_branch (inventory_transaction_id, branch_id),
    KEY idx_sales_reversal_link
        (
            reversal_inventory_transaction_id,
            inventory_transaction_id,
            branch_id
        ),
    CONSTRAINT fk_sales_branch
        FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_register_scope
        FOREIGN KEY (pos_register_id, branch_id)
        REFERENCES pos_registers (pos_register_id, branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_till_session_scope
        FOREIGN KEY (
            till_session_id,
            branch_id,
            pos_register_id,
            cashier_employee_id
        )
        REFERENCES till_sessions (
            till_session_id,
            branch_id,
            pos_register_id,
            cashier_employee_id
        )
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_customer
        FOREIGN KEY (customer_id) REFERENCES customers (customer_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_cashier
        FOREIGN KEY (cashier_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_inventory_txn
        FOREIGN KEY (inventory_transaction_id, branch_id)
        REFERENCES inventory_transactions (inventory_transaction_id, branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_reversal_txn
        FOREIGN KEY (
            reversal_inventory_transaction_id,
            inventory_transaction_id,
            branch_id
        )
        REFERENCES inventory_transactions (
            inventory_transaction_id,
            reversal_of_transaction_id,
            branch_id
        )
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_sales_state CHECK (
        (status = 'OPEN'
            AND inventory_transaction_id IS NULL
            AND reversal_inventory_transaction_id IS NULL
            AND sold_at IS NULL
            AND cancelled_at IS NULL
            AND voided_at IS NULL)
        OR
        (status = 'COMPLETED'
            AND inventory_transaction_id IS NOT NULL
            AND reversal_inventory_transaction_id IS NULL
            AND sold_at IS NOT NULL
            AND cancelled_at IS NULL
            AND voided_at IS NULL)
        OR
        (status = 'CANCELLED'
            AND inventory_transaction_id IS NULL
            AND reversal_inventory_transaction_id IS NULL
            AND sold_at IS NULL
            AND cancelled_at IS NOT NULL
            AND voided_at IS NULL)
        OR
        (status = 'VOIDED'
            AND inventory_transaction_id IS NOT NULL
            AND reversal_inventory_transaction_id IS NOT NULL
            AND sold_at IS NOT NULL
            AND cancelled_at IS NULL
            AND voided_at IS NOT NULL)
    ),
    CONSTRAINT chk_sales_void_date CHECK (
        voided_at IS NULL OR sold_at IS NULL OR voided_at >= sold_at
    ),
    CONSTRAINT chk_sales_distinct_transactions CHECK (
        reversal_inventory_transaction_id IS NULL
        OR reversal_inventory_transaction_id <> inventory_transaction_id
    ),
    CONSTRAINT chk_sales_amounts CHECK (
        subtotal_amount >= 0.00
        AND discount_amount >= 0.00
        AND discount_amount <= subtotal_amount
        AND tax_amount >= 0.00
        AND total_amount >= 0.00
    ),
    CONSTRAINT chk_sales_total CHECK (
        total_amount = ROUND(
            subtotal_amount - discount_amount + tax_amount,
            2
        )
    ),
    CONSTRAINT chk_sales_currency CHECK (CHAR_LENGTH(currency_code) = 3),
    CONSTRAINT chk_sales_session_register CHECK (
        till_session_id IS NULL OR pos_register_id IS NOT NULL
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS sale_items (
    sale_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sale_id BIGINT UNSIGNED NOT NULL,
    line_number SMALLINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    product_package_id BIGINT UNSIGNED NULL,
    barcode_id BIGINT UNSIGNED NULL,
    item_description VARCHAR(255) NOT NULL,
    sku_snapshot VARCHAR(64) NOT NULL,
    package_name_snapshot VARCHAR(120) NULL,
    quantity DECIMAL(15, 3) NOT NULL,
    package_conversion_factor DECIMAL(18, 6) NOT NULL DEFAULT 1.000000,
    base_quantity DECIMAL(15, 3) NOT NULL,
    unit_price DECIMAL(19, 4) NOT NULL,
    unit_cost DECIMAL(19, 4) NULL,
    discount_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    tax_rate_percent DECIMAL(7, 4) NOT NULL DEFAULT 0.0000,
    tax_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    line_total DECIMAL(19, 2) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (sale_item_id),
    CONSTRAINT uq_sale_items_line UNIQUE (sale_id, line_number),
    CONSTRAINT uq_sale_items_return_scope
        UNIQUE (sale_item_id, sale_id, product_variant_id),
    CONSTRAINT uq_sale_items_id_variant
        UNIQUE (sale_item_id, product_variant_id),
    KEY idx_sale_items_variant (product_variant_id, sale_id),
    KEY idx_sale_items_package_variant
        (product_package_id, product_variant_id),
    KEY idx_sale_items_barcode_variant (barcode_id, product_variant_id),
    CONSTRAINT fk_sale_items_sale
        FOREIGN KEY (sale_id) REFERENCES sales (sale_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_items_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants (product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_items_package
        FOREIGN KEY (product_package_id, product_variant_id)
        REFERENCES product_packages (product_package_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_items_barcode
        FOREIGN KEY (barcode_id, product_variant_id)
        REFERENCES product_barcodes (barcode_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_sale_items_line CHECK (line_number > 0),
    CONSTRAINT chk_sale_items_quantity CHECK (
        quantity > 0.000
        AND package_conversion_factor > 0.000000
        AND base_quantity > 0.000
        AND base_quantity = ROUND(
            quantity * package_conversion_factor,
            3
        )
    ),
    CONSTRAINT chk_sale_items_legacy_package CHECK (
        product_package_id IS NOT NULL
        OR package_conversion_factor = 1.000000
    ),
    CONSTRAINT chk_sale_items_price CHECK (unit_price >= 0.0000),
    CONSTRAINT chk_sale_items_cost CHECK (unit_cost IS NULL OR unit_cost >= 0.0000),
    CONSTRAINT chk_sale_items_discount CHECK (discount_amount >= 0.00),
    CONSTRAINT chk_sale_items_tax_rate CHECK (
        tax_rate_percent >= 0.0000 AND tax_rate_percent <= 100.0000
    ),
    CONSTRAINT chk_sale_items_tax CHECK (tax_amount >= 0.00),
    CONSTRAINT chk_sale_items_total CHECK (line_total >= 0.00)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS sale_item_lots (
    sale_item_lot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sale_item_id BIGINT UNSIGNED NOT NULL,
    inventory_lot_id BIGINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    base_quantity_allocated DECIMAL(15, 3) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (sale_item_lot_id),
    CONSTRAINT uq_sale_item_lots UNIQUE (sale_item_id, inventory_lot_id),
    KEY idx_sale_item_lots_lot (inventory_lot_id, sale_item_id),
    KEY idx_sale_item_lots_item_variant (sale_item_id, product_variant_id),
    CONSTRAINT fk_sale_item_lots_item_variant
        FOREIGN KEY (sale_item_id, product_variant_id)
        REFERENCES sale_items (sale_item_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_item_lots_lot_variant
        FOREIGN KEY (inventory_lot_id, product_variant_id)
        REFERENCES inventory_lots (inventory_lot_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_sale_item_lots_quantity CHECK (
        base_quantity_allocated > 0.000
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS return_reasons (
    return_reason_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    reason_code VARCHAR(50) NOT NULL,
    reason_name VARCHAR(120) NOT NULL,
    description VARCHAR(500) NULL,
    default_restockable TINYINT UNSIGNED NOT NULL DEFAULT 0,
    requires_approval TINYINT UNSIGNED NOT NULL DEFAULT 0,
    is_active TINYINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (return_reason_id),
    CONSTRAINT uq_return_reasons_code UNIQUE (reason_code),
    CONSTRAINT uq_return_reasons_name UNIQUE (reason_name),
    CONSTRAINT chk_return_reasons_flags CHECK (
        default_restockable IN (0, 1)
        AND requires_approval IN (0, 1)
        AND is_active IN (0, 1)
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS sales_returns (
    sales_return_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    return_number VARCHAR(50) NOT NULL,
    original_sale_id BIGINT UNSIGNED NOT NULL,
    branch_id BIGINT UNSIGNED NOT NULL,
    customer_id BIGINT UNSIGNED NULL,
    processed_by_employee_id BIGINT UNSIGNED NOT NULL,
    approved_by_employee_id BIGINT UNSIGNED NULL,
    cancelled_by_employee_id BIGINT UNSIGNED NULL,
    inventory_transaction_id BIGINT UNSIGNED NULL,
    approval_required TINYINT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM(
        'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'COMPLETED', 'CANCELLED'
    ) NOT NULL DEFAULT 'DRAFT',
    requested_at DATETIME(6) NOT NULL,
    approved_at DATETIME(6) NULL,
    completed_at DATETIME(6) NULL,
    cancelled_at DATETIME(6) NULL,
    refund_total_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    notes VARCHAR(1000) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (sales_return_id),
    CONSTRAINT uq_sales_returns_number UNIQUE (return_number),
    CONSTRAINT uq_sales_returns_inventory_txn UNIQUE (inventory_transaction_id),
    CONSTRAINT uq_sales_returns_id_sale
        UNIQUE (sales_return_id, original_sale_id),
    KEY idx_sales_returns_sale_date (original_sale_id, requested_at),
    KEY idx_sales_returns_branch_status (branch_id, status, requested_at),
    KEY idx_sales_returns_customer_date (customer_id, requested_at),
    KEY idx_sales_returns_processed_by (processed_by_employee_id, requested_at),
    KEY idx_sales_returns_approved_by (approved_by_employee_id),
    KEY idx_sales_returns_cancelled_by (cancelled_by_employee_id),
    KEY idx_sales_returns_txn_branch (inventory_transaction_id, branch_id),
    CONSTRAINT fk_sales_returns_sale_scope
        FOREIGN KEY (original_sale_id, branch_id)
        REFERENCES sales (sale_id, branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_returns_customer
        FOREIGN KEY (customer_id) REFERENCES customers (customer_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_returns_processed_by
        FOREIGN KEY (processed_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_returns_approved_by
        FOREIGN KEY (approved_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_returns_cancelled_by
        FOREIGN KEY (cancelled_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_returns_inventory_txn
        FOREIGN KEY (inventory_transaction_id, branch_id)
        REFERENCES inventory_transactions (inventory_transaction_id, branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_sales_returns_flags CHECK (approval_required IN (0, 1)),
    CONSTRAINT chk_sales_returns_refund CHECK (refund_total_amount >= 0.00),
    CONSTRAINT chk_sales_returns_actor_dates CHECK (
        ((approved_at IS NULL AND approved_by_employee_id IS NULL)
            OR (approved_at IS NOT NULL AND approved_by_employee_id IS NOT NULL))
        AND
        ((cancelled_at IS NULL AND cancelled_by_employee_id IS NULL)
            OR (cancelled_at IS NOT NULL
                AND cancelled_by_employee_id IS NOT NULL))
        AND
        (approved_by_employee_id IS NULL
            OR approved_by_employee_id <> processed_by_employee_id)
    ),
    CONSTRAINT chk_sales_returns_state CHECK (
        (status = 'DRAFT'
            AND approved_at IS NULL
            AND completed_at IS NULL
            AND cancelled_at IS NULL
            AND inventory_transaction_id IS NULL)
        OR
        (status = 'PENDING_APPROVAL'
            AND approval_required = 1
            AND approved_at IS NULL
            AND completed_at IS NULL
            AND cancelled_at IS NULL
            AND inventory_transaction_id IS NULL)
        OR
        (status = 'APPROVED'
            AND approved_at IS NOT NULL
            AND completed_at IS NULL
            AND cancelled_at IS NULL
            AND inventory_transaction_id IS NULL)
        OR
        (status = 'COMPLETED'
            AND completed_at IS NOT NULL
            AND cancelled_at IS NULL
            AND (approval_required = 0 OR approved_at IS NOT NULL))
        OR
        (status = 'CANCELLED'
            AND completed_at IS NULL
            AND cancelled_at IS NOT NULL
            AND inventory_transaction_id IS NULL)
    ),
    CONSTRAINT chk_sales_returns_dates CHECK (
        (approved_at IS NULL OR approved_at >= requested_at)
        AND (completed_at IS NULL OR completed_at >= requested_at)
        AND (completed_at IS NULL OR approved_at IS NULL
            OR completed_at >= approved_at)
        AND (cancelled_at IS NULL OR cancelled_at >= requested_at)
        AND (cancelled_at IS NULL OR approved_at IS NULL
            OR cancelled_at >= approved_at)
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS sales_return_items (
    sales_return_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sales_return_id BIGINT UNSIGNED NOT NULL,
    original_sale_id BIGINT UNSIGNED NOT NULL,
    original_sale_item_id BIGINT UNSIGNED NULL,
    line_number SMALLINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    product_package_id BIGINT UNSIGNED NULL,
    inventory_lot_id BIGINT UNSIGNED NULL,
    return_reason_id BIGINT UNSIGNED NOT NULL,
    item_description VARCHAR(255) NOT NULL,
    sku_snapshot VARCHAR(64) NOT NULL,
    package_name_snapshot VARCHAR(120) NULL,
    quantity_returned DECIMAL(15, 3) NOT NULL,
    package_conversion_factor DECIMAL(18, 6) NOT NULL DEFAULT 1.000000,
    base_quantity_returned DECIMAL(15, 3) NOT NULL,
    item_condition ENUM(
        'UNOPENED', 'OPENED', 'DAMAGED', 'EXPIRED', 'DEFECTIVE', 'OTHER'
    ) NOT NULL,
    is_restockable TINYINT UNSIGNED NOT NULL DEFAULT 0,
    refund_amount DECIMAL(19, 2) NOT NULL DEFAULT 0.00,
    notes VARCHAR(500) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (sales_return_item_id),
    CONSTRAINT uq_sales_return_items_line
        UNIQUE (sales_return_id, line_number),
    KEY idx_sales_return_items_sale_item
        (original_sale_item_id, original_sale_id, product_variant_id),
    KEY idx_sales_return_items_variant
        (product_variant_id, sales_return_id),
    KEY idx_sales_return_items_package_variant
        (product_package_id, product_variant_id),
    KEY idx_sales_return_items_lot_variant
        (inventory_lot_id, product_variant_id),
    KEY idx_sales_return_items_reason (return_reason_id),
    CONSTRAINT fk_sales_return_items_return_sale
        FOREIGN KEY (sales_return_id, original_sale_id)
        REFERENCES sales_returns (sales_return_id, original_sale_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_return_items_original_item
        FOREIGN KEY (
            original_sale_item_id,
            original_sale_id,
            product_variant_id
        )
        REFERENCES sale_items (sale_item_id, sale_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_return_items_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants (product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_return_items_package
        FOREIGN KEY (product_package_id, product_variant_id)
        REFERENCES product_packages (product_package_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_return_items_lot
        FOREIGN KEY (inventory_lot_id, product_variant_id)
        REFERENCES inventory_lots (inventory_lot_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sales_return_items_reason
        FOREIGN KEY (return_reason_id) REFERENCES return_reasons (return_reason_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_sales_return_items_line CHECK (line_number > 0),
    CONSTRAINT chk_sales_return_items_quantity CHECK (
        quantity_returned > 0.000
        AND package_conversion_factor > 0.000000
        AND base_quantity_returned > 0.000
        AND base_quantity_returned = ROUND(
            quantity_returned * package_conversion_factor,
            3
        )
    ),
    CONSTRAINT chk_sales_return_items_legacy_package CHECK (
        product_package_id IS NOT NULL
        OR package_conversion_factor = 1.000000
    ),
    CONSTRAINT chk_sales_return_items_restockable CHECK (
        is_restockable IN (0, 1)
        AND NOT (
            is_restockable = 1
            AND item_condition IN ('DAMAGED', 'EXPIRED')
        )
    ),
    CONSTRAINT chk_sales_return_items_refund CHECK (refund_amount >= 0.00)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS payment_methods (
    payment_method_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    method_code VARCHAR(30) NOT NULL,
    method_name VARCHAR(100) NOT NULL,
    method_type ENUM(
        'CASH', 'CARD', 'BANK_TRANSFER',
        'MOBILE_MONEY', 'VOUCHER', 'OTHER'
    ) NOT NULL,
    requires_reference TINYINT UNSIGNED NOT NULL DEFAULT 0,
    is_active TINYINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (payment_method_id),
    CONSTRAINT uq_payment_methods_code UNIQUE (method_code),
    CONSTRAINT uq_payment_methods_name UNIQUE (method_name),
    CONSTRAINT chk_payment_methods_reference CHECK (requires_reference IN (0, 1)),
    CONSTRAINT chk_payment_methods_active CHECK (is_active IN (0, 1))
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS sale_payments (
    sale_payment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    payment_number VARCHAR(50) NOT NULL,
    sale_id BIGINT UNSIGNED NOT NULL,
    sales_return_id BIGINT UNSIGNED NULL,
    payment_method_id BIGINT UNSIGNED NOT NULL,
    processed_by_employee_id BIGINT UNSIGNED NOT NULL,
    payment_type ENUM('PAYMENT', 'REFUND') NOT NULL DEFAULT 'PAYMENT',
    status ENUM('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED')
        NOT NULL DEFAULT 'PENDING',
    amount DECIMAL(19, 2) NOT NULL,
    currency_code CHAR(3) NOT NULL,
    external_reference VARCHAR(150) NULL,
    paid_at DATETIME(6) NULL,
    notes VARCHAR(500) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (sale_payment_id),
    CONSTRAINT uq_sale_payments_number UNIQUE (payment_number),
    CONSTRAINT uq_sale_payments_external_ref
        UNIQUE (payment_method_id, external_reference),
    KEY idx_sale_payments_sale_status (sale_id, status, paid_at),
    KEY idx_sale_payments_return_sale (sales_return_id, sale_id),
    KEY idx_sale_payments_method_date (payment_method_id, paid_at),
    KEY idx_sale_payments_employee_date (processed_by_employee_id, paid_at),
    CONSTRAINT fk_sale_payments_sale
        FOREIGN KEY (sale_id) REFERENCES sales (sale_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_payments_return
        FOREIGN KEY (sales_return_id, sale_id)
        REFERENCES sales_returns (sales_return_id, original_sale_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_payments_method
        FOREIGN KEY (payment_method_id)
        REFERENCES payment_methods (payment_method_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_sale_payments_employee
        FOREIGN KEY (processed_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_sale_payments_amount CHECK (amount > 0.00),
    CONSTRAINT chk_sale_payments_return_type CHECK (
        sales_return_id IS NULL OR payment_type = 'REFUND'
    ),
    CONSTRAINT chk_sale_payments_currency CHECK (CHAR_LENGTH(currency_code) = 3),
    CONSTRAINT chk_sale_payments_paid_at CHECK (
        (status = 'COMPLETED' AND paid_at IS NOT NULL)
        OR (status <> 'COMPLETED' AND paid_at IS NULL)
    )
) ENGINE = InnoDB;

-- =========================================================
-- Inter-branch stock transfers
-- =========================================================

CREATE TABLE IF NOT EXISTS stock_transfers (
    stock_transfer_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    transfer_number VARCHAR(50) NOT NULL,
    source_branch_id BIGINT UNSIGNED NOT NULL,
    destination_branch_id BIGINT UNSIGNED NOT NULL,
    status ENUM(
        'DRAFT', 'REQUESTED', 'APPROVED',
        'IN_TRANSIT', 'RECEIVED', 'CANCELLED'
    ) NOT NULL DEFAULT 'DRAFT',
    requested_by_employee_id BIGINT UNSIGNED NOT NULL,
    approved_by_employee_id BIGINT UNSIGNED NULL,
    dispatched_by_employee_id BIGINT UNSIGNED NULL,
    received_by_employee_id BIGINT UNSIGNED NULL,
    cancelled_by_employee_id BIGINT UNSIGNED NULL,
    source_inventory_transaction_id BIGINT UNSIGNED NULL,
    destination_inventory_transaction_id BIGINT UNSIGNED NULL,
    requested_at DATETIME(6) NULL,
    approved_at DATETIME(6) NULL,
    dispatched_at DATETIME(6) NULL,
    received_at DATETIME(6) NULL,
    cancelled_at DATETIME(6) NULL,
    notes VARCHAR(1000) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (stock_transfer_id),
    CONSTRAINT uq_stock_transfers_number UNIQUE (transfer_number),
    CONSTRAINT uq_stock_transfers_source_txn
        UNIQUE (source_inventory_transaction_id),
    CONSTRAINT uq_stock_transfers_destination_txn
        UNIQUE (destination_inventory_transaction_id),
    KEY idx_stock_transfers_source_status
        (source_branch_id, status, requested_at),
    KEY idx_stock_transfers_destination_status
        (destination_branch_id, status, requested_at),
    KEY idx_stock_transfers_requested_by (requested_by_employee_id),
    KEY idx_stock_transfers_approved_by (approved_by_employee_id),
    KEY idx_stock_transfers_dispatched_by (dispatched_by_employee_id),
    KEY idx_stock_transfers_received_by (received_by_employee_id),
    KEY idx_stock_transfers_cancelled_by (cancelled_by_employee_id),
    KEY idx_stock_transfers_source_txn_branch
        (source_inventory_transaction_id, source_branch_id),
    KEY idx_stock_transfers_dest_txn_branch
        (destination_inventory_transaction_id, destination_branch_id),
    CONSTRAINT fk_stock_transfers_source_branch
        FOREIGN KEY (source_branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_transfers_destination_branch
        FOREIGN KEY (destination_branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_transfers_requested_by
        FOREIGN KEY (requested_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_transfers_approved_by
        FOREIGN KEY (approved_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_transfers_dispatched_by
        FOREIGN KEY (dispatched_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_transfers_received_by
        FOREIGN KEY (received_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_transfers_cancelled_by
        FOREIGN KEY (cancelled_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_transfers_source_txn
        FOREIGN KEY (source_inventory_transaction_id, source_branch_id)
        REFERENCES inventory_transactions (inventory_transaction_id, branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_transfers_destination_txn
        FOREIGN KEY (destination_inventory_transaction_id, destination_branch_id)
        REFERENCES inventory_transactions (inventory_transaction_id, branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_transfers_branches CHECK (
        source_branch_id <> destination_branch_id
    ),
    CONSTRAINT chk_stock_transfers_state CHECK (
        (status = 'DRAFT'
            AND requested_at IS NULL
            AND approved_at IS NULL
            AND dispatched_at IS NULL
            AND received_at IS NULL
            AND cancelled_at IS NULL
            AND source_inventory_transaction_id IS NULL
            AND destination_inventory_transaction_id IS NULL)
        OR
        (status = 'REQUESTED'
            AND requested_at IS NOT NULL
            AND approved_at IS NULL
            AND dispatched_at IS NULL
            AND received_at IS NULL
            AND cancelled_at IS NULL
            AND source_inventory_transaction_id IS NULL
            AND destination_inventory_transaction_id IS NULL)
        OR
        (status = 'APPROVED'
            AND requested_at IS NOT NULL
            AND approved_at IS NOT NULL
            AND dispatched_at IS NULL
            AND received_at IS NULL
            AND cancelled_at IS NULL
            AND source_inventory_transaction_id IS NULL
            AND destination_inventory_transaction_id IS NULL)
        OR
        (status = 'IN_TRANSIT'
            AND requested_at IS NOT NULL
            AND approved_at IS NOT NULL
            AND dispatched_at IS NOT NULL
            AND received_at IS NULL
            AND cancelled_at IS NULL
            AND source_inventory_transaction_id IS NOT NULL
            AND destination_inventory_transaction_id IS NULL)
        OR
        (status = 'RECEIVED'
            AND requested_at IS NOT NULL
            AND approved_at IS NOT NULL
            AND dispatched_at IS NOT NULL
            AND received_at IS NOT NULL
            AND cancelled_at IS NULL
            AND source_inventory_transaction_id IS NOT NULL
            AND destination_inventory_transaction_id IS NOT NULL)
        OR
        (status = 'CANCELLED'
            AND cancelled_at IS NOT NULL
            AND dispatched_at IS NULL
            AND received_at IS NULL
            AND source_inventory_transaction_id IS NULL
            AND destination_inventory_transaction_id IS NULL)
    ),
    CONSTRAINT chk_stock_transfers_actor_dates CHECK (
        ((approved_at IS NULL AND approved_by_employee_id IS NULL)
            OR (approved_at IS NOT NULL AND approved_by_employee_id IS NOT NULL))
        AND
        ((dispatched_at IS NULL AND dispatched_by_employee_id IS NULL)
            OR (dispatched_at IS NOT NULL
                AND dispatched_by_employee_id IS NOT NULL))
        AND
        ((received_at IS NULL AND received_by_employee_id IS NULL)
            OR (received_at IS NOT NULL AND received_by_employee_id IS NOT NULL))
        AND
        ((cancelled_at IS NULL AND cancelled_by_employee_id IS NULL)
            OR (cancelled_at IS NOT NULL
                AND cancelled_by_employee_id IS NOT NULL))
    ),
    CONSTRAINT chk_stock_transfers_dates CHECK (
        (approved_at IS NULL
            OR (requested_at IS NOT NULL AND approved_at >= requested_at))
        AND
        (dispatched_at IS NULL
            OR (approved_at IS NOT NULL AND dispatched_at >= approved_at))
        AND
        (received_at IS NULL
            OR (dispatched_at IS NOT NULL AND received_at >= dispatched_at))
        AND
        (cancelled_at IS NULL OR requested_at IS NULL OR cancelled_at >= requested_at)
        AND
        (cancelled_at IS NULL OR approved_at IS NULL OR cancelled_at >= approved_at)
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS stock_transfer_items (
    stock_transfer_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    stock_transfer_id BIGINT UNSIGNED NOT NULL,
    line_number SMALLINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    quantity_requested DECIMAL(15, 3) NOT NULL,
    quantity_dispatched DECIMAL(15, 3) NOT NULL DEFAULT 0.000,
    quantity_received DECIMAL(15, 3) NOT NULL DEFAULT 0.000,
    notes VARCHAR(500) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (stock_transfer_item_id),
    CONSTRAINT uq_stock_transfer_items_line
        UNIQUE (stock_transfer_id, line_number),
    CONSTRAINT uq_stock_transfer_items_variant
        UNIQUE (stock_transfer_id, product_variant_id),
    CONSTRAINT uq_stock_transfer_items_id_variant
        UNIQUE (stock_transfer_item_id, product_variant_id),
    KEY idx_stock_transfer_items_variant
        (product_variant_id, stock_transfer_id),
    CONSTRAINT fk_stock_transfer_items_transfer
        FOREIGN KEY (stock_transfer_id)
        REFERENCES stock_transfers (stock_transfer_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_transfer_items_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants (product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_transfer_items_line CHECK (line_number > 0),
    CONSTRAINT chk_stock_transfer_items_quantities CHECK (
        quantity_requested > 0.000
        AND quantity_dispatched >= 0.000
        AND quantity_received >= 0.000
        AND quantity_dispatched <= quantity_requested
        AND quantity_received <= quantity_dispatched
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS stock_transfer_item_lots (
    stock_transfer_item_lot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    stock_transfer_item_id BIGINT UNSIGNED NOT NULL,
    inventory_lot_id BIGINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    quantity_requested DECIMAL(15, 3) NOT NULL,
    quantity_dispatched DECIMAL(15, 3) NOT NULL DEFAULT 0.000,
    quantity_received DECIMAL(15, 3) NOT NULL DEFAULT 0.000,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (stock_transfer_item_lot_id),
    CONSTRAINT uq_stock_transfer_item_lots
        UNIQUE (stock_transfer_item_id, inventory_lot_id),
    KEY idx_stock_transfer_lots_lot (inventory_lot_id, stock_transfer_item_id),
    KEY idx_stock_transfer_lots_item_variant
        (stock_transfer_item_id, product_variant_id),
    CONSTRAINT fk_stock_transfer_lots_item_variant
        FOREIGN KEY (stock_transfer_item_id, product_variant_id)
        REFERENCES stock_transfer_items
            (stock_transfer_item_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_transfer_lots_lot_variant
        FOREIGN KEY (inventory_lot_id, product_variant_id)
        REFERENCES inventory_lots (inventory_lot_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_transfer_lots_quantities CHECK (
        quantity_requested > 0.000
        AND quantity_dispatched >= 0.000
        AND quantity_received >= 0.000
        AND quantity_dispatched <= quantity_requested
        AND quantity_received <= quantity_dispatched
    )
) ENGINE = InnoDB;

-- =========================================================
-- Controlled inventory corrections
-- =========================================================

CREATE TABLE IF NOT EXISTS inventory_adjustments (
    inventory_adjustment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    adjustment_number VARCHAR(50) NOT NULL,
    branch_id BIGINT UNSIGNED NOT NULL,
    adjustment_type ENUM(
        'COUNT_CORRECTION', 'DAMAGE', 'EXPIRY',
        'THEFT', 'SUPPLIER_RETURN', 'OTHER'
    ) NOT NULL,
    status ENUM('DRAFT', 'APPROVED', 'POSTED', 'CANCELLED')
        NOT NULL DEFAULT 'DRAFT',
    reason VARCHAR(1000) NOT NULL,
    created_by_employee_id BIGINT UNSIGNED NOT NULL,
    approved_by_employee_id BIGINT UNSIGNED NULL,
    cancelled_by_employee_id BIGINT UNSIGNED NULL,
    inventory_transaction_id BIGINT UNSIGNED NULL,
    adjusted_at DATETIME(6) NULL,
    approved_at DATETIME(6) NULL,
    posted_at DATETIME(6) NULL,
    cancelled_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (inventory_adjustment_id),
    CONSTRAINT uq_inventory_adjustments_number UNIQUE (adjustment_number),
    CONSTRAINT uq_inventory_adjustments_txn UNIQUE (inventory_transaction_id),
    CONSTRAINT uq_inventory_adjustments_id_branch
        UNIQUE (inventory_adjustment_id, branch_id),
    KEY idx_inventory_adjustments_branch_status
        (branch_id, status, adjusted_at),
    KEY idx_inventory_adjustments_created_by (created_by_employee_id),
    KEY idx_inventory_adjustments_approved_by (approved_by_employee_id),
    KEY idx_inventory_adjustments_cancelled_by (cancelled_by_employee_id),
    KEY idx_inventory_adjustments_txn_branch
        (inventory_transaction_id, branch_id),
    CONSTRAINT fk_inventory_adjustments_branch
        FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_adjustments_created_by
        FOREIGN KEY (created_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_adjustments_approved_by
        FOREIGN KEY (approved_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_adjustments_cancelled_by
        FOREIGN KEY (cancelled_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_adjustments_txn
        FOREIGN KEY (inventory_transaction_id, branch_id)
        REFERENCES inventory_transactions (inventory_transaction_id, branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_adjustments_state CHECK (
        (status = 'DRAFT'
            AND inventory_transaction_id IS NULL
            AND approved_at IS NULL
            AND posted_at IS NULL
            AND cancelled_at IS NULL)
        OR
        (status = 'APPROVED'
            AND inventory_transaction_id IS NULL
            AND adjusted_at IS NOT NULL
            AND approved_at IS NOT NULL
            AND posted_at IS NULL
            AND cancelled_at IS NULL)
        OR
        (status = 'POSTED'
            AND inventory_transaction_id IS NOT NULL
            AND adjusted_at IS NOT NULL
            AND approved_at IS NOT NULL
            AND posted_at IS NOT NULL
            AND cancelled_at IS NULL)
        OR
        (status = 'CANCELLED'
            AND inventory_transaction_id IS NULL
            AND posted_at IS NULL
            AND cancelled_at IS NOT NULL)
    ),
    CONSTRAINT chk_inventory_adjustments_actor_dates CHECK (
        ((approved_at IS NULL AND approved_by_employee_id IS NULL)
            OR (approved_at IS NOT NULL AND approved_by_employee_id IS NOT NULL))
        AND
        ((cancelled_at IS NULL AND cancelled_by_employee_id IS NULL)
            OR (cancelled_at IS NOT NULL
                AND cancelled_by_employee_id IS NOT NULL))
        AND
        (approved_by_employee_id IS NULL
            OR approved_by_employee_id <> created_by_employee_id)
    ),
    CONSTRAINT chk_inventory_adjustments_dates CHECK (
        (approved_at IS NULL
            OR (adjusted_at IS NOT NULL AND approved_at >= adjusted_at))
        AND
        (posted_at IS NULL
            OR (approved_at IS NOT NULL AND posted_at >= approved_at))
        AND
        (cancelled_at IS NULL
            OR adjusted_at IS NULL
            OR cancelled_at >= adjusted_at)
        AND
        (cancelled_at IS NULL
            OR approved_at IS NULL
            OR cancelled_at >= approved_at)
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS inventory_adjustment_items (
    inventory_adjustment_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    inventory_adjustment_id BIGINT UNSIGNED NOT NULL,
    line_number SMALLINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    quantity_change DECIMAL(15, 3) NOT NULL,
    unit_cost DECIMAL(19, 4) NULL,
    reason VARCHAR(500) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (inventory_adjustment_item_id),
    CONSTRAINT uq_inventory_adjustment_items_line
        UNIQUE (inventory_adjustment_id, line_number),
    CONSTRAINT uq_inventory_adjustment_items_variant
        UNIQUE (inventory_adjustment_id, product_variant_id),
    CONSTRAINT uq_inventory_adjustment_items_id_variant
        UNIQUE (inventory_adjustment_item_id, product_variant_id),
    KEY idx_inventory_adjustment_items_variant
        (product_variant_id, inventory_adjustment_id),
    CONSTRAINT fk_inventory_adjustment_items_adjustment
        FOREIGN KEY (inventory_adjustment_id)
        REFERENCES inventory_adjustments (inventory_adjustment_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_adjustment_items_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants (product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_adjustment_items_line CHECK (line_number > 0),
    CONSTRAINT chk_inventory_adjustment_items_quantity CHECK (
        quantity_change <> 0.000
    ),
    CONSTRAINT chk_inventory_adjustment_items_cost CHECK (
        unit_cost IS NULL OR unit_cost >= 0.0000
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS inventory_adjustment_item_lots (
    inventory_adjustment_item_lot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    inventory_adjustment_item_id BIGINT UNSIGNED NOT NULL,
    inventory_lot_id BIGINT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    quantity_change DECIMAL(15, 3) NOT NULL,
    unit_cost DECIMAL(19, 4) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (inventory_adjustment_item_lot_id),
    CONSTRAINT uq_inventory_adjustment_item_lots
        UNIQUE (inventory_adjustment_item_id, inventory_lot_id),
    KEY idx_inventory_adjustment_lots_lot
        (inventory_lot_id, inventory_adjustment_item_id),
    KEY idx_inventory_adjustment_lots_item_variant
        (inventory_adjustment_item_id, product_variant_id),
    CONSTRAINT fk_inventory_adjustment_lots_item_variant
        FOREIGN KEY (inventory_adjustment_item_id, product_variant_id)
        REFERENCES inventory_adjustment_items
            (inventory_adjustment_item_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_inventory_adjustment_lots_lot_variant
        FOREIGN KEY (inventory_lot_id, product_variant_id)
        REFERENCES inventory_lots (inventory_lot_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_inventory_adjustment_lots_quantity CHECK (
        quantity_change <> 0.000
    ),
    CONSTRAINT chk_inventory_adjustment_lots_cost CHECK (
        unit_cost IS NULL OR unit_cost >= 0.0000
    )
) ENGINE = InnoDB;

-- =========================================================
-- Formal physical stock counts
-- =========================================================

CREATE TABLE IF NOT EXISTS stock_counts (
    stock_count_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    count_number VARCHAR(50) NOT NULL,
    branch_id BIGINT UNSIGNED NOT NULL,
    count_type ENUM('FULL', 'CYCLE', 'SPOT') NOT NULL DEFAULT 'FULL',
    status ENUM(
        'DRAFT', 'IN_PROGRESS', 'COUNTED',
        'APPROVED', 'POSTED', 'CANCELLED'
    ) NOT NULL DEFAULT 'DRAFT',
    created_by_employee_id BIGINT UNSIGNED NOT NULL,
    approved_by_employee_id BIGINT UNSIGNED NULL,
    posted_by_employee_id BIGINT UNSIGNED NULL,
    cancelled_by_employee_id BIGINT UNSIGNED NULL,
    inventory_adjustment_id BIGINT UNSIGNED NULL,
    started_at DATETIME(6) NULL,
    completed_at DATETIME(6) NULL,
    approved_at DATETIME(6) NULL,
    posted_at DATETIME(6) NULL,
    cancelled_at DATETIME(6) NULL,
    notes VARCHAR(1000) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (stock_count_id),
    CONSTRAINT uq_stock_counts_number UNIQUE (count_number),
    CONSTRAINT uq_stock_counts_adjustment UNIQUE (inventory_adjustment_id),
    KEY idx_stock_counts_branch_status (branch_id, status, started_at),
    KEY idx_stock_counts_created_by (created_by_employee_id),
    KEY idx_stock_counts_approved_by (approved_by_employee_id),
    KEY idx_stock_counts_posted_by (posted_by_employee_id),
    KEY idx_stock_counts_cancelled_by (cancelled_by_employee_id),
    KEY idx_stock_counts_adjustment_branch (inventory_adjustment_id, branch_id),
    CONSTRAINT fk_stock_counts_branch
        FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_counts_created_by
        FOREIGN KEY (created_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_counts_approved_by
        FOREIGN KEY (approved_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_counts_posted_by
        FOREIGN KEY (posted_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_counts_cancelled_by
        FOREIGN KEY (cancelled_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_counts_adjustment
        FOREIGN KEY (inventory_adjustment_id, branch_id)
        REFERENCES inventory_adjustments (inventory_adjustment_id, branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_counts_actor_dates CHECK (
        ((approved_at IS NULL AND approved_by_employee_id IS NULL)
            OR (approved_at IS NOT NULL AND approved_by_employee_id IS NOT NULL))
        AND
        ((posted_at IS NULL AND posted_by_employee_id IS NULL)
            OR (posted_at IS NOT NULL AND posted_by_employee_id IS NOT NULL))
        AND
        ((cancelled_at IS NULL AND cancelled_by_employee_id IS NULL)
            OR (cancelled_at IS NOT NULL
                AND cancelled_by_employee_id IS NOT NULL))
        AND
        (approved_by_employee_id IS NULL
            OR approved_by_employee_id <> created_by_employee_id)
    ),
    CONSTRAINT chk_stock_counts_state CHECK (
        (status = 'DRAFT'
            AND started_at IS NULL
            AND completed_at IS NULL
            AND approved_at IS NULL
            AND posted_at IS NULL
            AND cancelled_at IS NULL
            AND inventory_adjustment_id IS NULL)
        OR
        (status = 'IN_PROGRESS'
            AND started_at IS NOT NULL
            AND completed_at IS NULL
            AND approved_at IS NULL
            AND posted_at IS NULL
            AND cancelled_at IS NULL
            AND inventory_adjustment_id IS NULL)
        OR
        (status = 'COUNTED'
            AND started_at IS NOT NULL
            AND completed_at IS NOT NULL
            AND approved_at IS NULL
            AND posted_at IS NULL
            AND cancelled_at IS NULL
            AND inventory_adjustment_id IS NULL)
        OR
        (status = 'APPROVED'
            AND started_at IS NOT NULL
            AND completed_at IS NOT NULL
            AND approved_at IS NOT NULL
            AND posted_at IS NULL
            AND cancelled_at IS NULL
            AND inventory_adjustment_id IS NULL)
        OR
        (status = 'POSTED'
            AND started_at IS NOT NULL
            AND completed_at IS NOT NULL
            AND approved_at IS NOT NULL
            AND posted_at IS NOT NULL
            AND cancelled_at IS NULL)
        OR
        (status = 'CANCELLED'
            AND posted_at IS NULL
            AND cancelled_at IS NOT NULL
            AND inventory_adjustment_id IS NULL)
    ),
    CONSTRAINT chk_stock_counts_dates CHECK (
        (completed_at IS NULL
            OR (started_at IS NOT NULL AND completed_at >= started_at))
        AND
        (approved_at IS NULL
            OR (completed_at IS NOT NULL AND approved_at >= completed_at))
        AND
        (posted_at IS NULL
            OR (approved_at IS NOT NULL AND posted_at >= approved_at))
        AND
        (cancelled_at IS NULL OR started_at IS NULL
            OR cancelled_at >= started_at)
        AND
        (cancelled_at IS NULL OR completed_at IS NULL
            OR cancelled_at >= completed_at)
        AND
        (cancelled_at IS NULL OR approved_at IS NULL
            OR cancelled_at >= approved_at)
    )
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS stock_count_participants (
    stock_count_id BIGINT UNSIGNED NOT NULL,
    employee_id BIGINT UNSIGNED NOT NULL,
    participant_role ENUM('COUNTER', 'SUPERVISOR', 'OBSERVER')
        NOT NULL DEFAULT 'COUNTER',
    assigned_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (stock_count_id, employee_id),
    KEY idx_stock_count_participants_employee (employee_id, stock_count_id),
    CONSTRAINT fk_stock_count_participants_count
        FOREIGN KEY (stock_count_id) REFERENCES stock_counts (stock_count_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_count_participants_employee
        FOREIGN KEY (employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS stock_count_items (
    stock_count_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    stock_count_id BIGINT UNSIGNED NOT NULL,
    line_number INT UNSIGNED NOT NULL,
    product_variant_id BIGINT UNSIGNED NOT NULL,
    inventory_lot_id BIGINT UNSIGNED NULL,
    system_quantity DECIMAL(15, 3) NOT NULL,
    counted_quantity DECIMAL(15, 3) NULL,
    variance_quantity DECIMAL(15, 3)
        GENERATED ALWAYS AS (
            CASE
                WHEN counted_quantity IS NULL THEN NULL
                ELSE counted_quantity - system_quantity
            END
        ) STORED,
    lot_scope_guard BIGINT UNSIGNED
        GENERATED ALWAYS AS (COALESCE(inventory_lot_id, 0)) STORED,
    counted_by_employee_id BIGINT UNSIGNED NULL,
    counted_at DATETIME(6) NULL,
    variance_reason VARCHAR(500) NULL,
    notes VARCHAR(500) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (stock_count_item_id),
    CONSTRAINT uq_stock_count_items_line
        UNIQUE (stock_count_id, line_number),
    CONSTRAINT uq_stock_count_items_scope
        UNIQUE (
            stock_count_id,
            product_variant_id,
            lot_scope_guard
        ),
    KEY idx_stock_count_items_variant (product_variant_id, stock_count_id),
    KEY idx_stock_count_items_lot_variant
        (inventory_lot_id, product_variant_id),
    KEY idx_stock_count_items_counted_by (counted_by_employee_id),
    CONSTRAINT fk_stock_count_items_count
        FOREIGN KEY (stock_count_id) REFERENCES stock_counts (stock_count_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_count_items_variant
        FOREIGN KEY (product_variant_id)
        REFERENCES product_variants (product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_count_items_lot
        FOREIGN KEY (inventory_lot_id, product_variant_id)
        REFERENCES inventory_lots (inventory_lot_id, product_variant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_stock_count_items_counted_by
        FOREIGN KEY (counted_by_employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_stock_count_items_line CHECK (line_number > 0),
    CONSTRAINT chk_stock_count_items_quantities CHECK (
        system_quantity >= 0.000
        AND (counted_quantity IS NULL OR counted_quantity >= 0.000)
    ),
    CONSTRAINT chk_stock_count_items_actor_time CHECK (
        (counted_quantity IS NULL
            AND counted_at IS NULL
            AND counted_by_employee_id IS NULL)
        OR
        (counted_quantity IS NOT NULL
            AND counted_at IS NOT NULL
            AND counted_by_employee_id IS NOT NULL)
    ),
    CONSTRAINT chk_stock_count_items_variance_reason CHECK (
        variance_quantity IS NULL
        OR variance_quantity = 0.000
        OR (
            variance_reason IS NOT NULL
            AND CHAR_LENGTH(TRIM(variance_reason)) > 0
        )
    )
) ENGINE = InnoDB;

-- =========================================================
-- General non-stock audit trail
-- =========================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    audit_log_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NULL,
    employee_id BIGINT UNSIGNED NULL,
    branch_id BIGINT UNSIGNED NULL,
    action_type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_record_id VARCHAR(100) NOT NULL,
    occurred_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    before_values JSON NULL,
    after_values JSON NULL,
    ip_address VARCHAR(45) NULL,
    user_agent VARCHAR(1000) NULL,
    request_id VARCHAR(100) NULL,
    notes VARCHAR(1000) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (audit_log_id),
    KEY idx_audit_logs_entity
        (entity_type, entity_record_id, occurred_at),
    KEY idx_audit_logs_user_time (user_id, occurred_at),
    KEY idx_audit_logs_employee_time (employee_id, occurred_at),
    KEY idx_audit_logs_branch_time (branch_id, occurred_at),
    KEY idx_audit_logs_action_time (action_type, occurred_at),
    KEY idx_audit_logs_request (request_id),
    CONSTRAINT fk_audit_logs_user
        FOREIGN KEY (user_id) REFERENCES users (user_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_audit_logs_employee
        FOREIGN KEY (employee_id) REFERENCES employees (employee_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_audit_logs_branch
        FOREIGN KEY (branch_id) REFERENCES branches (branch_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_audit_logs_action CHECK (
        CHAR_LENGTH(TRIM(action_type)) > 0
    ),
    CONSTRAINT chk_audit_logs_entity CHECK (
        CHAR_LENGTH(TRIM(entity_type)) > 0
        AND CHAR_LENGTH(TRIM(entity_record_id)) > 0
    )
) ENGINE = InnoDB;
