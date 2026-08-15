package main

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

type CrawlerDB struct {
	Conn *sql.DB
}

func OpenDatabase(filename string) (*CrawlerDB, error) {
	db, err := sql.Open("sqlite", filename)
	if err != nil {
		println(err)
		return nil, err
	}

	fmt.Println("Database opened successfully!")

	return &CrawlerDB{Conn: db}, nil
}

func (db *CrawlerDB) CloseDatabase() error {
	err := db.Conn.Close()
	if err != nil {
		println(err)
		return err
	}
	println("Database conn closed!")
	return nil
}

func (db *CrawlerDB) CreateTables() error {
	query := `
	CREATE TABLE IF NOT EXISTS wiki_region (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name VARCHAR NOT NULL
	);

	CREATE TABLE IF NOT EXISTS page (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		insert_datetime TIMESTAMP NOT NULL,
		last_update_datetime TIMESTAMP NOT NULL,
		region_id INTEGER NOT NULL,
		title VARCHAR NOT NULL
	);

	CREATE TABLE IF NOT EXISTS link (
		src INTEGER NOT NULL,
		dst INTEGER NOT NULL,
		insert_datetime TIMESTAMP NOT NULL,
		PRIMARY KEY (src, dst)
	);

	CREATE TABLE IF NOT EXISTS queue (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		page_id INTEGER NOT NULL
	);
	`

	_, err := db.Conn.Exec(query)
	if err != nil {
		println(err)
		return err
	}

	fmt.Println("Tables created successfully!")
	return nil
}
