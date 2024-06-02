/// <reference path="../pb_data/types.d.ts" />
migrate((db) => {
  const dao = new Dao(db)
  const collection = dao.findCollectionByNameOrId("n2am2jzldlkzg2o")

  // add
  collection.schema.addField(new SchemaField({
    "system": false,
    "id": "footy0qj",
    "name": "eventId",
    "type": "text",
    "required": false,
    "presentable": false,
    "unique": false,
    "options": {
      "min": null,
      "max": null,
      "pattern": ""
    }
  }))

  return dao.saveCollection(collection)
}, (db) => {
  const dao = new Dao(db)
  const collection = dao.findCollectionByNameOrId("n2am2jzldlkzg2o")

  // remove
  collection.schema.removeField("footy0qj")

  return dao.saveCollection(collection)
})
