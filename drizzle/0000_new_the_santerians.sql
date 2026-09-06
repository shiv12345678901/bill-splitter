CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`payer` text NOT NULL,
	`merchant` text NOT NULL,
	`amount` real NOT NULL,
	`category` text DEFAULT 'Other' NOT NULL,
	`image_key` text,
	`settled` integer DEFAULT false NOT NULL
);
