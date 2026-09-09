import express from "express"
import isAuth from "../middlewares/isAuth.js"
import { upload } from "../middlewares/multer.js"
import { addItem, deleteItem, editItem, getItemById, getItemsByCity, getItemsByShop, searchItemsSemantic } from "../controllers/item.controllers.js"

const itemRouter = express.Router()

itemRouter.get("/search/semantic", searchItemsSemantic)
itemRouter.get("/getitemsbyshop/:shopId",isAuth,getItemsByShop)
itemRouter.get("/getitemsbycity/:city",isAuth,getItemsByCity)
itemRouter.post("/additem",isAuth,upload.single("image"),addItem)
itemRouter.post("/edititem/:itemId",isAuth,upload.single("image"),editItem)
itemRouter.delete("/delete/:itemId",isAuth,deleteItem)
itemRouter.get("/getbyid/:itemId",isAuth,getItemById)

export default itemRouter