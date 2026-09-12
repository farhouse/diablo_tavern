import { MongoClient } from 'mongodb'
import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'

dotenv.config()

const MONGODB_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017'
const DB_NAME = process.env.MONGO_DB_NAME || 'diablo_management'

async function resetPassword(email: string, newPassword: string) {
  const client = new MongoClient(MONGODB_URI)
  
  try {
    await client.connect()
    const db = client.db(DB_NAME)
    const users = db.collection('users')
    
    const user = await users.findOne({ email: email.toLowerCase() })
    
    if (!user) {
      console.log(`User ${email} not found`)
      return
    }
    
    const passwordHash = await bcrypt.hash(newPassword, 12)
    
    await users.updateOne(
      { _id: user._id },
      { 
        $set: { 
          passwordHash,
          updatedAt: new Date().toISOString()
        }
      }
    )
    
    console.log(`Password reset successfully for ${email}`)
    console.log(`New password: ${newPassword}`)
  } catch (error) {
    console.error('Error:', error)
  } finally {
    await client.close()
  }
}

const email = process.argv[2] || 'farhouse@gmail.com'
const newPassword = process.argv[3] || 'password123'

resetPassword(email, newPassword)