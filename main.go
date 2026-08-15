package main

import (
	_ "modernc.org/sqlite"
)

const DATABASE_FILENAME = "crawler.db"

func main() {
	db, err := OpenDatabase(DATABASE_FILENAME)
	if err != nil {
		return
	}
	defer db.CloseDatabase()

	err = db.CreateTables()

	if err != nil {
		return
	}

	/*
	   c := colly.NewCollector()

	   // Find and visit all links

	   	c.OnHTML("a[href]", func(e *colly.HTMLElement) {
	   		e.Request.Visit(e.Attr("href"))
	   	})

	   	c.OnRequest(func(r *colly.Request) {
	   		fmt.Println("Visiting", r.URL)
	   	})

	   c.Visit("http://go-colly.org/")
	*/
}
