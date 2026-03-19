"""Authentication routes: register, login, me."""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from .. import auth as auth_module
from .. import crud, models, schemas
from ..database import get_session

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=schemas.TokenResponse)
def register_user(payload: schemas.UserCreate, db: Session = Depends(get_session)):
    existing = crud.get_user_by_email(db, payload.email)
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user = crud.create_user(db, payload, auth_module.hash_password(payload.password))
    crud.get_or_create_default_account(db, user.id)
    token = auth_module.create_access_token(user)
    return {"access_token": token, "token_type": "bearer", "user": user}


@router.post("/login", response_model=schemas.TokenResponse)
def login_user(payload: schemas.LoginRequest, db: Session = Depends(get_session)):
    user = crud.get_user_by_email(db, payload.email)
    if not user or not auth_module.verify_password(payload.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )
    token = auth_module.create_access_token(user)
    return {"access_token": token, "token_type": "bearer", "user": user}


@router.get("/me", response_model=schemas.UserPublic)
def get_me(current_user: models.User = Depends(auth_module.get_current_user)):
    return current_user
