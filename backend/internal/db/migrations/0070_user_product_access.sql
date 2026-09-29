-- +goose Up
CREATE TABLE user_product_access (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product TEXT NOT NULL CHECK (product IN ('files', 'rooms', 'notes', 'music')),
  access_level TEXT NOT NULL CHECK (access_level IN ('none', 'limited', 'full')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, product)
);

INSERT INTO user_product_access (user_id, product, access_level)
SELECT users.id, products.product,
  CASE
    WHEN users.rooms_only_account AND products.product <> 'rooms' THEN 'none'
    WHEN products.product = 'rooms' AND NOT users.rooms_access_enabled THEN 'none'
    ELSE 'full'
  END
FROM users
CROSS JOIN (VALUES ('files'::TEXT), ('rooms'::TEXT), ('notes'::TEXT), ('music'::TEXT)) AS products(product);

-- +goose Down
DROP TABLE user_product_access;