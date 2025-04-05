import { useState, useEffect } from 'react'
import './App.css'

function App() {
  const [repoUrl, setRepoUrl] = useState('')
  const [previewData, setPreviewData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [errorDetails, setErrorDetails] = useState('')
  const [serverStatus, setServerStatus] = useState('checking')

  // Check if backend server is running
  useEffect(() => {
    const checkServer = async () => {
      try {
        const response = await fetch('http://localhost:3001/health')
        if (response.ok) {
          setServerStatus('running')
        } else {
          setServerStatus('error')
        }
      } catch (err) {
        setServerStatus('error')
      }
    }

    checkServer()
    // Check server status every 10 seconds
    const interval = setInterval(checkServer, 10000)
    return () => clearInterval(interval)
  }, [])

  // Format GitHub URL to ensure it's valid
  const formatGitHubUrl = (url) => {
    try {
      const urlObj = new URL(url)
      // Remove trailing .git if present
      const cleanPath = urlObj.pathname.replace(/\.git$/, '')
      // Ensure it's a GitHub URL
      if (urlObj.hostname === 'github.com') {
        return `https://github.com${cleanPath}`
      }
      throw new Error('Not a GitHub URL')
    } catch (err) {
      throw new Error('Invalid URL format')
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setErrorDetails('')
    setPreviewData(null)

    try {
      // Validate and format GitHub URL
      const formattedUrl = formatGitHubUrl(repoUrl)

      const response = await fetch('http://localhost:3001/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ repoUrl: formattedUrl }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Server error')
      }

      const data = await response.json()
      
      if (data.success) {
        setPreviewData({
          imageUrl: `data:image/png;base64,${data.screenshot}`,
          previewUrl: data.previewUrl,
          message: data.message
        })
      } else {
        throw new Error(data.error || 'Failed to generate preview')
      }
    } catch (err) {
      setError(err.message || 'An error occurred')
      if (err.message.includes('fetch')) {
        setErrorDetails('The backend server is not responding. Please make sure it\'s running on port 3001')
      } else {
        setErrorDetails(err.message)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="container">
      <h1>GitHub Repository Preview</h1>
      <p className="description">
        Enter a GitHub repository URL to generate a live preview and screenshot.
      </p>
      
      {serverStatus === 'error' && (
        <div className="server-error">
          <h3>⚠️ Backend Server Not Running</h3>
          <p>Please start the backend server using:</p>
          <code>cd backend && npm run dev</code>
        </div>
      )}

      <form onSubmit={handleSubmit} className="form">
        <div className="input-group">
          <input
            type="text"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/username/repository"
            className="input"
            required
          />
          <div className="input-hint">
            Example: https://github.com/facebook/react
          </div>
        </div>
        <button 
          type="submit" 
          disabled={loading || serverStatus === 'error'} 
          className="button"
        >
          {loading ? 'Generating Preview...' : 'Generate Preview'}
        </button>
      </form>

      {loading && (
        <div className="loading">
          <div className="spinner"></div>
          <p>Setting up preview... This may take a few minutes</p>
          <p className="loading-hint">We are cloning the repository and setting up the development environment</p>
        </div>
      )}
      
      {error && (
        <div className="error-container">
          <h3>Error</h3>
          <p className="error">{error}</p>
          {errorDetails && <p className="error-details">{errorDetails}</p>}
        </div>
      )}

      {previewData && (
        <div className="preview-container">
          <h2>Preview Generated!</h2>
          <p className="success-message">{previewData.message}</p>
          
          <div className="preview-section">
            <h3>Screenshot</h3>
            <img
              src={previewData.imageUrl}
              alt="Repository Screenshot"
              className="screenshot"
            />
          </div>
          
          <div className="preview-section">
            <h3>Live Preview URL</h3>
            <p className="preview-url">
              Your site is running at:{' '}
              <a 
                href={previewData.previewUrl} 
                target="_blank" 
                rel="noopener noreferrer"
                className="preview-link"
              >
                {previewData.previewUrl}
              </a>
            </p>
            <p className="preview-hint">
              Click the link above to open the live preview in a new tab
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
