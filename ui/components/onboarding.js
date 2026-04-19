import { state } from '../state.js'

let currentStep = 1
const TOTAL_STEPS = 5

// Starter follow accounts
const STARTER_FOLLOWS = {
  swarmneroOfficial: '5f5ef421cd609b2d98d8ef3d11eb53bfb623ac3d8126e4189b1aaead1298ee52'
}

export function initOnboarding() {
  // Next button
  const nextBtn = document.getElementById('onboardingNext')
  if (nextBtn) {
    nextBtn.addEventListener('click', handleNext)
  }

  // Back button
  const backBtn = document.getElementById('onboardingBack')
  if (backBtn) {
    backBtn.addEventListener('click', handleBack)
  }

  // Skip link
  const skipLink = document.getElementById('onboardingSkip')
  if (skipLink) {
    skipLink.addEventListener('click', (e) => {
      e.preventDefault()
      completeOnboarding()
    })
  }

  // Step dots (allow clicking to navigate)
  const dots = document.querySelectorAll('.onboarding-step')
  dots.forEach((dot, index) => {
    dot.addEventListener('click', () => {
      goToStep(index + 1)
    })
  })
}

export function showOnboarding() {
  currentStep = 1
  updateUI()

  const modal = document.getElementById('onboardingModal')
  if (modal) {
    modal.classList.remove('hidden')
  }
}

export function shouldShowOnboarding() {
  // Check per-account onboarding status
  const accountName = state.activeAccountName
  if (!accountName) return false
  return localStorage.getItem(`swarmnero_onboarding_complete_${accountName}`) !== 'true'
}

function handleNext() {
  if (currentStep === 4) {
    // Handle starter follows in background (don't block UI)
    handleStarterFollows()
  }

  if (currentStep < TOTAL_STEPS) {
    goToStep(currentStep + 1)
  } else {
    // Last step - complete onboarding
    completeOnboarding()
  }
}

function handleBack() {
  if (currentStep > 1) {
    goToStep(currentStep - 1)
  }
}

function goToStep(step) {
  if (step < 1 || step > TOTAL_STEPS) return

  currentStep = step
  updateUI()
}

function updateUI() {
  // Hide all steps
  for (let i = 1; i <= TOTAL_STEPS; i++) {
    const stepEl = document.getElementById(`onboardingStep${i}`)
    if (stepEl) {
      stepEl.classList.add('hidden')
    }
  }

  // Show current step
  const currentStepEl = document.getElementById(`onboardingStep${currentStep}`)
  if (currentStepEl) {
    currentStepEl.classList.remove('hidden')
  }

  // Update back button visibility
  const backBtn = document.getElementById('onboardingBack')
  if (backBtn) {
    if (currentStep === 1) {
      backBtn.classList.add('hidden')
    } else {
      backBtn.classList.remove('hidden')
    }
  }

  // Update next button text
  const nextBtn = document.getElementById('onboardingNext')
  if (nextBtn) {
    nextBtn.textContent = currentStep === TOTAL_STEPS ? 'Get Started' : 'Continue'
  }

  // Update step dots
  const dots = document.querySelectorAll('.onboarding-step')
  dots.forEach((dot, index) => {
    if (index + 1 === currentStep) {
      dot.classList.add('active')
    } else {
      dot.classList.remove('active')
    }
  })
}

async function handleStarterFollows() {
  // Check if Swarmnero Official is selected
  const swarmneroCheckbox = document.getElementById('followSwarmneroOfficial')
  if (swarmneroCheckbox && swarmneroCheckbox.checked && state.feed) {
    try {
      await state.feed.follow(STARTER_FOLLOWS.swarmneroOfficial)
    } catch (e) {
      console.error('[Onboarding] Failed to follow starter account:', e)
    }
  }
}

function completeOnboarding() {
  // Mark per-account onboarding as complete
  const accountName = state.activeAccountName
  if (accountName) {
    localStorage.setItem(`swarmnero_onboarding_complete_${accountName}`, 'true')
  }

  const modal = document.getElementById('onboardingModal')
  if (modal) {
    modal.classList.add('hidden')
  }
}
