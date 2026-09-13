# Wikipedia Crawler


### Test docker container for MongoDB
```
docker run --name wikipediaCrawler -p 27017:27017 -e MONGO_INITDB_ROOT_USERNAME=crawler -e MONGO_INITDB_ROOT_PASSWORD=testpass -d mongo:latest
```

### Test docker container for Neo4J
```
docker run -d --name my-neo4j -p 7474:7474 -p 7687:7687 -v ./neo4j_data:/data -e NEO4J_AUTH=crawler/testpass -e NEO4J_server_memory_heap_initial__size=2G -e NEO4J_server_memory_heap_max__size=4G neo4j
```
